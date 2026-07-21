import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
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
  /** Aurora MySQL クラスター用セキュリティグループ */
  public readonly auroraSecurityGroup: ec2.SecurityGroup;
  /** メディアアセット保存用 S3 バケット */
  public readonly mediaBucket: s3.Bucket;
  /** 行動ログ Raw データ保存用 S3 バケット */
  public readonly actionLogRawBucket: s3.Bucket;
  /** 行動ログ Athena 中間成果物保存用 S3 バケット */
  public readonly actionLogIntermediateBucket: s3.Bucket;
  /** CloudFront / ALB アクセスログ保存用 S3 バケット */
  public readonly accessLogBucket?: s3.Bucket;
  /** 外部システム向けログ配信用 S3 バケット */
  public readonly logDeliveryBucket: s3.Bucket;
  /** アプリ API コンテナイメージ用 ECR リポジトリ */
  public readonly appApiRepository: ecr.Repository;
  /** 管理 API コンテナイメージ用 ECR リポジトリ */
  public readonly mgtApiRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName, envConfig, vpc } = props;
    const mediaUploadAllowedOrigins = isPlaceholder(envConfig.edgeDomainName)
      ? undefined
      : [`https://${envConfig.edgeDomainName}`];
    // prod は設定値にかかわらずデータリソースを保持する。
    // retainDataResources=false は dev 初回構築向け。有効データ投入後は true に変更してから destroy する。
    const shouldRetainDataResources = envName === 'prod' || envConfig.retainDataResources;
    const dataRemovalPolicy = shouldRetainDataResources
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;
    const autoDeleteDataObjects = !shouldRetainDataResources;

    // ────────────────────────────────────────────────
    // Aurora MySQL セキュリティグループ
    // DB アクセス元のスタックから Security Group 単位で 3306 を許可する
    // ────────────────────────────────────────────────
    this.auroraSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'Security group for Aurora MySQL cluster',
      allowAllOutbound: false,
    });

    // ────────────────────────────────────────────────
    // Aurora MySQL クラスター（L2 DatabaseCluster）
    // auroraMultiAz が true の場合のみリーダーインスタンスを追加
    // ────────────────────────────────────────────────
    const dbInstanceClassPattern = /^db\.(.+)$/;
    const dbInstanceClassMatch = envConfig.dbInstanceClass.match(dbInstanceClassPattern);
    if (dbInstanceClassMatch === null) {
      throw new Error(
        `dbInstanceClass must use the RDS format "db.<family>.<size>": ${envConfig.dbInstanceClass}`,
      );
    }
    const auroraInstanceType = new ec2.InstanceType(dbInstanceClassMatch[1]);

    const readers = envConfig.auroraMultiAz
      ? [
          rds.ClusterInstance.provisioned('Reader', {
            instanceType: auroraInstanceType,
          }),
        ]
      : [];

    this.auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_04_0,
      }),
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceType: auroraInstanceType,
      }),
      readers,
      // DB 名は snake_case（MySQL 命名規則に合わせる）
      defaultDatabaseName: buildResourceName(envName, 'db').replace(/-/g, '_'),
      credentials: rds.Credentials.fromGeneratedSecret('admin', {
        secretName: buildResourceName(envName, 'aurora-secret'),
      }),
      storageEncrypted: true,
      deletionProtection: shouldRetainDataResources,
      removalPolicy: dataRemovalPolicy,
      vpc,
      // データベースサブネット（isolated）に配置
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.auroraSecurityGroup],
    });

    // クラスターに紐付いたシークレットをエクスポート
    this.auroraSecret = this.auroraCluster.secret!;
    const auroraSecretResource = this.auroraCluster.node
      .findChild('Secret')
      .node.findChild('Resource') as secretsmanager.CfnSecret;
    auroraSecretResource.applyRemovalPolicy(dataRemovalPolicy);

    if (envName === 'dev') {
      const debugDbTunnelSg = new ec2.SecurityGroup(this, 'DebugDbTunnelSg', {
        vpc,
        description: 'Security group for dev DB tunnel instance',
        allowAllOutbound: false,
      });
      debugDbTunnelSg.addEgressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        'Allow SSM agent outbound HTTPS',
      );
      debugDbTunnelSg.addEgressRule(
        this.auroraSecurityGroup,
        ec2.Port.tcp(3306),
        'Allow MySQL access to Aurora',
      );

      this.auroraSecurityGroup.addIngressRule(
        debugDbTunnelSg,
        ec2.Port.tcp(3306),
        'Allow MySQL access from dev DB tunnel instance',
      );

      const debugDbTunnelRole = new iam.Role(this, 'DebugDbTunnelRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ],
      });

      const debugDbTunnelInstance = new ec2.Instance(this, 'DebugDbTunnelInstance', {
        vpc,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
        machineImage: ec2.MachineImage.latestAmazonLinux2023({
          cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        }),
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroup: debugDbTunnelSg,
        role: debugDbTunnelRole,
        requireImdsv2: true,
      });
      cdk.Tags.of(debugDbTunnelInstance).add('Name', buildResourceName(envName, 'debug-db-tunnel'));

      new cdk.CfnOutput(this, 'DebugDbTunnelInstanceId', {
        value: debugDbTunnelInstance.instanceId,
      });

      new cdk.CfnOutput(this, 'AuroraClusterEndpoint', {
        value: this.auroraCluster.clusterEndpoint.hostname,
      });

      new cdk.CfnOutput(this, 'DebugDbTunnelCommand', {
        value: cdk.Fn.join('', [
          'aws ssm start-session --target ',
          debugDbTunnelInstance.instanceId,
          ' --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=',
          this.auroraCluster.clusterEndpoint.hostname,
          ',portNumber=3306,localPortNumber=13306"',
        ]),
      });
    }

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

    if (envConfig.enableAccessLogs) {
      this.accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
        bucketName: envConfig.accessLogBucketName,
        versioned: false,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        enforceSSL: true,
        removalPolicy: dataRemovalPolicy,
        autoDeleteObjects: autoDeleteDataObjects,
        lifecycleRules: [
          {
            expiration: cdk.Duration.days(envConfig.accessLogRetentionDays),
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          },
        ],
      });
    }

    // ────────────────────────────────────────────────
    // API コンテナイメージ用 ECR リポジトリ
    // stg/prod はタグを固定し、デプロイとロールバックの対象を明確化する
    // ────────────────────────────────────────────────
    const createApiRepository = (id: string, resource: string): ecr.Repository => {
      const repository = new ecr.Repository(this, id, {
        repositoryName: buildResourceName(envName, resource).toLowerCase(),
        imageScanOnPush: true,
        imageTagMutability:
          envName === 'dev' ? ecr.TagMutability.MUTABLE : ecr.TagMutability.IMMUTABLE,
        removalPolicy: dataRemovalPolicy,
      });
      // タグ付きイメージはロールバック用に一定数保持し、タグなしイメージは短期で削除する
      repository.addLifecycleRule({
        tagStatus: ecr.TagStatus.TAGGED,
        tagPatternList: ['*'],
        maxImageCount: envConfig.apiTaggedImageRetentionCount,
        description: `Retain latest ${envConfig.apiTaggedImageRetentionCount} tagged images`,
      });
      repository.addLifecycleRule({
        tagStatus: ecr.TagStatus.UNTAGGED,
        maxImageAge: cdk.Duration.days(envConfig.apiUntaggedImageRetentionDays),
        description: `Retain untagged images for ${envConfig.apiUntaggedImageRetentionDays} days`,
      });
      return repository;
    };

    this.appApiRepository = createApiRepository('AppApiRepository', 'app-api');
    this.mgtApiRepository = createApiRepository('MgtApiRepository', 'mgt-api');

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
            classification: 'json',
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
