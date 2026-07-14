import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName } from '../config/env-config';

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
  /** 動画保存用 S3 バケット */
  public readonly videoBucket: s3.Bucket;
  /** アプリコンテナイメージ用 ECR リポジトリ */
  public readonly appRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName, envConfig, vpc } = props;

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
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpc,
      // データベースサブネット（isolated）に配置
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
    });

    // クラスターに紐付いたシークレットをエクスポート
    this.auroraSecret = this.auroraCluster.secret!;

    // ────────────────────────────────────────────────
    // 動画保存用 S3 バケット
    // バケット名は CDK が自動生成（ハードコードしない）
    // ────────────────────────────────────────────────
    this.videoBucket = new s3.Bucket(this, 'VideoBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      eventBridgeEnabled: envConfig.enableEventProcessing,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          // 1095 日（3 年）後に Glacier Deep Archive に移行
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(1095),
            },
          ],
        },
      ],
    });

    // ────────────────────────────────────────────────
    // アプリコンテナイメージ用 ECR リポジトリ
    // イメージの改ざん防止のためタグを immutable に設定
    // ────────────────────────────────────────────────
    this.appRepository = new ecr.Repository(this, 'AppRepository', {
      repositoryName: buildResourceName(envName, 'app').toLowerCase(),
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // 最新 10 イメージのみ保持するライフサイクルルール
    this.appRepository.addLifecycleRule({
      maxImageCount: 10,
      description: '最新10イメージのみ保持',
    });
  }
}
