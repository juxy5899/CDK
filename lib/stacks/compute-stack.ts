import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName, isPlaceholder } from '../config/env-config';

export interface ComputeStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  vpc: ec2.IVpc;
  appRepository: ecr.Repository;
  auroraSecret: secretsmanager.ISecret;
  eventQueue: sqs.IQueue;
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

    const { envName, envConfig, vpc, appRepository, auroraSecret, eventQueue } = props;

    // ────────────────────────────────────────────────
    // ALB セキュリティグループ
    // CloudFront Origin-Facing プレフィックスリストからのアクセスのみ許可
    // ────────────────────────────────────────────────
    const hasAlbCertificate = !isPlaceholder(envConfig.certificateArn);

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB 用セキュリティグループ',
    });
    albSg.addIngressRule(
      ec2.Peer.prefixList(envConfig.cloudFrontOriginPrefixListId),
      ec2.Port.tcp(hasAlbCertificate ? 443 : 80),
      hasAlbCertificate
        ? 'CloudFront からの HTTPS アクセスのみ許可'
        : 'CloudFront からの HTTP アクセスのみ許可',
    );

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

    // ALB リスナー
    // ACM 証明書が設定済みの場合は HTTPS (443)、未設定の場合は HTTP (80) で待ち受ける
    const listener = hasAlbCertificate
      ? this.alb.addListener('HttpsListener', {
          port: 443,
          open: false,
          certificates: [
            acm.Certificate.fromCertificateArn(this, 'AlbCertificate', envConfig.certificateArn),
          ],
        })
      : this.alb.addListener('HttpListener', {
          port: 80,
          open: false,
        });
    // TODO: ALB Listener に CloudFront カスタムヘッダー検証ルールを追加する

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
        EVENT_QUEUE_URL: eventQueue.queueUrl,
      },
      secrets: {
        // DB 接続情報を Secrets Manager から注入
        DB_SECRET_ARN: ecs.Secret.fromSecretsManager(auroraSecret),
      },
    });

    if (envConfig.enableXray) {
      // X-Ray SDK がローカルデーモンへ UDP 送信するための接続先
      container.addEnvironment('AWS_XRAY_DAEMON_ADDRESS', '127.0.0.1:2000');

      // X-Ray デーモンサイドカー
      // アプリケーションのトレースを収集し、X-Ray サービスへ転送する
      this.taskDefinition.addContainer('xray-daemon', {
        containerName: 'xray-daemon',
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:3.3.11'),
        essential: false,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: buildResourceName(envName, 'xray-daemon'),
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      }).addPortMappings({
        containerPort: 2000,
        protocol: ecs.Protocol.UDP,
      });

      // タスクロールに X-Ray 送信権限を付与
      this.taskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          sid: 'XrayWriteAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
            'xray:GetSamplingRules',
            'xray:GetSamplingTargets',
            'xray:GetSamplingStatisticSummaries',
          ],
          resources: ['*'],
        }),
      );
    }

    eventQueue.grantSendMessages(this.taskDefinition.taskRole);
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

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB の DNS 名。この値を environments.ts の albOriginDomainName に設定してください',
    });

    if (!hasAlbCertificate) {
      new cdk.CfnOutput(this, 'AlbTlsDisabledNotice', {
        value: 'Set certificateArn in environments.ts to enable HTTPS (443) on ALB origin',
      });
    }

  }
}
