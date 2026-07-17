import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName, isPlaceholder } from '../config/env-config';

export interface DataStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  vpc: ec2.IVpc;
}

export class DataStack extends cdk.Stack {
  /** Aurora MySQL クラスター */
  public readonly auroraCluster: rds.DatabaseCluster;
  /** Aurora 認証情報シークレット */
  public readonly auroraSecret: secretsmanager.ISecret;
  /** メディアアセット保存用 S3 バケット */
  public readonly mediaBucket: s3.Bucket;
  /** 行動ログ Raw データ保存用 S3 バケット */
  public readonly actionLogRawBucket: s3.Bucket;
  /** 行動ログ Athena 中間成果物保存用 S3 バケット */
  public readonly actionLogIntermediateBucket: s3.Bucket;
  /** 外部システム向けログ配信用 S3 バケット */
  public readonly logDeliveryBucket: s3.Bucket;
  /** アプリコンテナイメージ用 ECR リポジトリ */
  public readonly appRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName, envConfig, vpc } = props;
    const mediaUploadAllowedOrigins = isPlaceholder(envConfig.edgeDomainName)
      ? undefined
      : [`https://${envConfig.edgeDomainName}`];
    // retainDataResources=false は dev 初回構築向け。有効データ投入後は true に変更してから destroy する。
    const dataRemovalPolicy = envConfig.retainDataResources
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;
    const autoDeleteDataObjects = !envConfig.retainDataResources;

    // ────────────────────────────────────────────────
    // Aurora MySQL セキュリティグループ
    // VPC CIDR (10.0.0.0/16) からのポート 3306 のみ許可
    // ────────────────────────────────────────────────
    const auroraSg = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'Aurora MySQL クラスター用セキュリティグループ',
      allowAllOutbound: false,
    });
    auroraSg.addIngressRule(
      ec2.Peer.ipv4('10.0.0.0/16'),
      ec2.Port.tcp(3306),
      'VPC 内からの MySQL アクセスを許可',
    );

    // ────────────────────────────────────────────────
    // Aurora MySQL クラスター（L2 DatabaseCluster）
    // auroraMultiAz が true の場合のみリーダーインスタンスを追加
    // ────────────────────────────────────────────────
    const readers = envConfig.auroraMultiAz
      ? [
          rds.ClusterInstance.provisioned('Reader', {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE),
          }),
        ]
      : [];

    this.auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_04_0,
      }),
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE),
      }),
      readers,
      // DB 名は snake_case（MySQL 命名規則に合わせる）
      defaultDatabaseName: buildResourceName(envName, 'db').replace(/-/g, '_'),
      credentials: rds.Credentials.fromGeneratedSecret('admin', {
        secretName: buildResourceName(envName, 'aurora-secret'),
      }),
      storageEncrypted: true,
      deletionProtection: envConfig.retainDataResources,
      removalPolicy: dataRemovalPolicy,
      vpc,
      // データベースサブネット（isolated）に配置
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
    });

    // クラスターに紐付いたシークレットをエクスポート
    this.auroraSecret = this.auroraCluster.secret!;

    // ────────────────────────────────────────────────
    // メディアアセット保存用 S3 バケット
    // バケット名は環境設定で固定化する
    // ────────────────────────────────────────────────
    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      bucketName: envConfig.mediaBucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors:
        mediaUploadAllowedOrigins === undefined
          ? undefined
          : [
              {
                allowedOrigins: mediaUploadAllowedOrigins,
                allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
                allowedHeaders: ['*'],
                exposedHeaders: ['ETag'],
                maxAge: 3600,
              },
            ],
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: autoDeleteDataObjects,
      lifecycleRules: [
        {
          // アップロード中継領域は一時ファイルとして 3 日後に削除する
          prefix: envConfig.videoUploadPrefix,
          expiration: cdk.Duration.days(3),
          noncurrentVersionExpiration: cdk.Duration.days(3),
        },
        {
          // 正式オブジェクトは保持し、未完了の multipart upload のみ自動クリーンアップする
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ────────────────────────────────────────────────
    // 行動ログ Raw データ保存用 S3 バケット
    // Fluent Bit / FireLens が出力する JSON ログを Hive パーティション形式で保持する
    // ────────────────────────────────────────────────
    this.actionLogRawBucket = new s3.Bucket(this, 'ActionLogRawBucket', {
      bucketName: envConfig.actionLogRawBucketName,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: autoDeleteDataObjects,
      lifecycleRules: [
        {
          prefix: envConfig.actionLogRawPrefix,
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(365 * 3),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ────────────────────────────────────────────────
    // 行動ログ Athena 中間成果物保存用 S3 バケット
    // Athena UNLOAD の part-* / manifest を一時保持し、成功時は Lambda が限定削除する
    // ────────────────────────────────────────────────
    this.actionLogIntermediateBucket = new s3.Bucket(this, 'ActionLogIntermediateBucket', {
      bucketName: envConfig.actionLogIntermediateBucketName,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: autoDeleteDataObjects,
      lifecycleRules: [
        {
          prefix: envConfig.actionLogIntermediatePrefix,
          expiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ────────────────────────────────────────────────
    // アプリコンテナイメージ用 ECR リポジトリ
    // 外部パイプラインで latest を上書き運用できるようタグを mutable に設定
    // ────────────────────────────────────────────────
    this.appRepository = new ecr.Repository(this, 'AppRepository', {
      repositoryName: buildResourceName(envName, 'app').toLowerCase(),
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: dataRemovalPolicy,
    });
    // 最新 10 イメージのみ保持するライフサイクルルール
    this.appRepository.addLifecycleRule({
      maxImageCount: 10,
      description: '最新10イメージのみ保持',
    });

    // ────────────────────────────────────────────────
    // 行動ログ Delivery TSV 出力用 S3 バケット
    // Lambda が生成する TSV.GZ の受け渡し先とする
    // ────────────────────────────────────────────────
    this.logDeliveryBucket = new s3.Bucket(this, 'LogDeliveryBucket', {
      bucketName: envConfig.actionLogDeliveryBucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: autoDeleteDataObjects,
      lifecycleRules: [
        {
          prefix: envConfig.actionLogDeliveryEventsPrefix,
          expiration: cdk.Duration.days(envConfig.actionLogDeliveryRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(envConfig.actionLogDeliveryRetentionDays),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        {
          prefix: envConfig.actionLogDeliveryAttributesPrefix,
          expiration: cdk.Duration.days(envConfig.actionLogDeliveryRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(envConfig.actionLogDeliveryRetentionDays),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ────────────────────────────────────────────────
    // AWS Backup（Aurora + メディアバケット）
    // 日次バックアップを一元管理し、誤操作時の復旧ポイントを確保する
    // ────────────────────────────────────────────────
    if (envConfig.enableBackup) {
      const backupVault = new backup.BackupVault(this, 'DataBackupVault', {
        backupVaultName: buildResourceName(envName, 'data-backup-vault').toLowerCase(),
        removalPolicy: dataRemovalPolicy,
      });

      const backupPlan = new backup.BackupPlan(this, 'DataBackupPlan', {
        backupPlanName: buildResourceName(envName, 'data-daily-backup-plan').toLowerCase(),
        backupVault,
      });

      backupPlan.addRule(backup.BackupPlanRule.daily());

      backupPlan.addSelection('DataBackupSelection', {
        resources: [
          backup.BackupResource.fromRdsDatabaseCluster(this.auroraCluster),
          backup.BackupResource.fromArn(this.mediaBucket.bucketArn),
        ],
      });
    }

    // ────────────────────────────────────────────────
    // Athena / Glue（ログ分析用）
    // 結果出力用バケット、Workgroup、Raw 外部表を定義して SQL 分析基盤を標準化する
    // ────────────────────────────────────────────────
    if (envConfig.enableAthena) {
      const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
        bucketName: envConfig.athenaResultsBucketName,
        versioned: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: dataRemovalPolicy,
        autoDeleteObjects: autoDeleteDataObjects,
      });

      const athenaWorkgroupName = buildResourceName(envName, 'athena-workgroup').toLowerCase();

      new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
        name: athenaWorkgroupName,
        state: 'ENABLED',
        recursiveDeleteOption: false,
        workGroupConfiguration: {
          enforceWorkGroupConfiguration: true,
          publishCloudWatchMetricsEnabled: true,
          resultConfiguration: {
            outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
          },
        },
      });

      const actionLogDatabase = new glue.CfnDatabase(this, 'ActionLogDatabase', {
        catalogId: this.account,
        databaseInput: {
          name: envConfig.actionLogAthenaDatabaseName,
          description: 'Action log Athena database',
        },
      });

      const actionLogRawLocation = `s3://${this.actionLogRawBucket.bucketName}/${envConfig.actionLogRawPrefix}`;
      const actionLogRawLocationTemplate = `${actionLogRawLocation}year=\${year}/month=\${month}/day=\${day}/`;

      const actionLogRawTable = new glue.CfnTable(this, 'ActionLogRawTable', {
        catalogId: this.account,
        databaseName: envConfig.actionLogAthenaDatabaseName,
        tableInput: {
          name: envConfig.actionLogRawTableName,
          tableType: 'EXTERNAL_TABLE',
          parameters: {
            EXTERNAL: 'TRUE',
            'classification': 'json',
            'projection.enabled': 'true',
            'projection.year.type': 'integer',
            'projection.year.range': `${envConfig.actionLogProjectionStartYear},${envConfig.actionLogProjectionEndYear}`,
            'projection.year.digits': '4',
            'projection.month.type': 'integer',
            'projection.month.range': '1,12',
            'projection.month.digits': '2',
            'projection.day.type': 'integer',
            'projection.day.range': '1,31',
            'projection.day.digits': '2',
            'storage.location.template': actionLogRawLocationTemplate,
          },
          partitionKeys: [
            { name: 'year', type: 'string' },
            { name: 'month', type: 'string' },
            { name: 'day', type: 'string' },
          ],
          storageDescriptor: {
            location: actionLogRawLocation,
            inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
            outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            serdeInfo: {
              serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
              parameters: {
                'ignore.malformed.json': 'true',
              },
            },
            columns: [
              {
                name: 'device_info',
                type: 'struct<uuid:string,mypage_id:string,os:string,os_version:string,application_version:string>',
              },
              {
                name: 'events',
                type: 'array<struct<timestamp:string,type:string,screen_name:string,screen_name_id:string,source_screen_name:string,source_screen_id:string,event_category:string,event_action:string,event_label:string,event_value:string>>',
              },
              { name: 'server_received_at', type: 'string' },
              { name: 'ip_address', type: 'string' },
              { name: 'user_agent', type: 'string' },
            ],
          },
        },
      });
      actionLogRawTable.addDependency(actionLogDatabase);
    }
  }
}
