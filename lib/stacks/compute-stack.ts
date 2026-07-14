import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName } from '../config/env-config';

export interface ComputeStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  vpc: ec2.IVpc;
  appRepository: ecr.Repository;
  auroraSecret: secretsmanager.ISecret;
  /** WAF WebACL ARN（SecurityStack から渡す、undefined の場合は関連付けなし） */
  webAclArn?: string;
}

export class ComputeStack extends cdk.Stack {
  /** Application Load Balancer */
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** ECS クラスター */
  public readonly cluster: ecs.Cluster;
  /** Fargate タスク定義 */
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  /** ECS Fargate サービス */
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { envName, envConfig, vpc, appRepository, auroraSecret } = props;

    // ────────────────────────────────────────────────
    // ALB セキュリティグループ
    // インターネットからの HTTP (80) アクセスを許可
    // ────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB 用セキュリティグループ',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP アクセスを全許可');

    // ────────────────────────────────────────────────
    // Application Load Balancer（インターネット向け）
    // パブリックサブネットに配置
    // ────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    // HTTP リスナー（ポート 80）
    // TODO: Phase 3 で HTTPS (443) リスナーと ACM 証明書を追加予定
    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      open: false, // SG で制御するため open は false
    });

    // ────────────────────────────────────────────────
    // ECS クラスター
    // Container Insights を有効化してメトリクスを収集
    // ────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: buildResourceName(envName, 'cluster'),
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // ────────────────────────────────────────────────
    // Fargate タスク定義
    // CPU・メモリは環境設定から取得
    // ────────────────────────────────────────────────
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: envConfig.taskCpu,
      memoryLimitMiB: envConfig.taskMemoryMiB,
    });

    // アプリコンテナを追加
    const container = this.taskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromEcrRepository(appRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: buildResourceName(envName, 'app'),
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        APP_ENV: envName,
      },
      secrets: {
        // DB 接続情報を Secrets Manager から注入
        DB_SECRET_ARN: ecs.Secret.fromSecretsManager(auroraSecret),
      },
    });
    // コンテナポートマッピング（8080 番で受信）
    container.addPortMappings({ containerPort: 8080 });

    // ────────────────────────────────────────────────
    // ECS サービス用セキュリティグループ
    // ALB SG からのポート 8080 のみ許可
    // ────────────────────────────────────────────────
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      description: 'ECS Fargate サービス用セキュリティグループ',
    });
    serviceSg.addIngressRule(
      ec2.Peer.securityGroupId(albSg.securityGroupId),
      ec2.Port.tcp(8080),
      'ALB からのアクセスのみ許可',
    );

    // ────────────────────────────────────────────────
    // ECS Fargate サービス
    // プライベートサブネット（PRIVATE_WITH_EGRESS）に配置
    // ────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      serviceName: buildResourceName(envName, 'service'),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: envConfig.minTaskCount,
      assignPublicIp: false,
      securityGroups: [serviceSg],
      // stg/prod の 2 タスク高可用性を維持するため、ローリングデプロイ中も最小稼働数を保持する
      minHealthyPercent: envConfig.minTaskCount >= 2 ? 100 : 50,
      maxHealthyPercent: 200,
      // デプロイ失敗時に自動ロールバック
      circuitBreaker: { rollback: true },
    });

    // ALB ターゲットグループにサービスを登録
    listener.addTargets('ServiceTarget', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/health',
        port: '8080',
        protocol: elbv2.Protocol.HTTP,
      },
    });

    // ────────────────────────────────────────────────
    // Application Auto Scaling
    // CPU・メモリ使用率に応じてタスク数をスケール
    // ────────────────────────────────────────────────
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: envConfig.minTaskCount,
      maxCapacity: envConfig.maxTaskCount,
    });

    // CPU 使用率 70% でスケールアウト
    scaling.scaleOnCpuUtilization('CpuScaleOut', {
      targetUtilizationPercent: 70,
      scaleOutCooldown: cdk.Duration.seconds(300),
      scaleInCooldown: cdk.Duration.seconds(300),
    });

    // メモリ使用率 80% でスケールアウト
    scaling.scaleOnMemoryUtilization('MemScaleOut', {
      targetUtilizationPercent: 80,
      scaleOutCooldown: cdk.Duration.seconds(300),
      scaleInCooldown: cdk.Duration.seconds(300),
    });

    // ────────────────────────────────────────────────
    // WAF WebACL と ALB の関連付け
    // webAclArn が提供されている場合のみ実行
    // ────────────────────────────────────────────────
    if (props.webAclArn) {
      new wafv2.CfnWebACLAssociation(this, 'WafAlbAssociation', {
        resourceArn: this.alb.loadBalancerArn,
        webAclArn: props.webAclArn,
      });
    }
  }
}
