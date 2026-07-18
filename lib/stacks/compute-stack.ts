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
  appImageTag: string;
  strictValidation: boolean;
  auroraSecret: secretsmanager.ISecret;
  auroraSecurityGroup: ec2.ISecurityGroup;
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

    const { envName, envConfig, vpc, appRepository, appImageTag, strictValidation, auroraSecret, auroraSecurityGroup, eventQueue } = props;

    // ────────────────────────────────────────────────
    // ALB セキュリティグループ
    // CloudFront Origin-Facing プレフィックスリストからのアクセスのみ許可
    // ────────────────────────────────────────────────
    const hasAlbCertificate = !isPlaceholder(envConfig.certificateArn);
    const hasOriginVerifyHeader = !isPlaceholder(envConfig.cloudFrontOriginVerifyHeaderValue);
    const hasAppImageTag = !isPlaceholder(appImageTag);
    const allowDirectAlbAccess = envName === 'dev';

    if (strictValidation && envName !== 'dev' && !hasAlbCertificate) {
      throw new Error(`${envName} requires certificateArn to enable HTTPS between CloudFront and ALB`);
    }

    if (strictValidation && envName !== 'dev' && !hasOriginVerifyHeader) {
      throw new Error(`${envName} requires cloudFrontOriginVerifyHeaderValue for ALB origin verification`);
    }

    if (strictValidation && envName !== 'dev' && !hasAppImageTag) {
      throw new Error(`${envName} requires -c appImageTag=<immutable-image-tag> for ComputeStack deployment`);
    }

    if (envName !== 'dev' && (!hasAlbCertificate || !hasOriginVerifyHeader || !hasAppImageTag)) {
      cdk.Annotations.of(this).addWarning(
        'ComputeStack has placeholder deployment inputs. Use -c strictComputeValidation=true with certificateArn, originVerifyHeaderValue, and appImageTag before deploying Compute/Edge.',
      );
    }

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Security group for ALB',
    });
    albSg.addIngressRule(
      allowDirectAlbAccess
        ? ec2.Peer.anyIpv4()
        : ec2.Peer.prefixList(envConfig.cloudFrontOriginPrefixListId),
      ec2.Port.tcp(hasAlbCertificate ? 443 : 80),
      allowDirectAlbAccess
        ? 'Allow direct HTTP access for dev'
        : hasAlbCertificate
          ? 'Allow HTTPS access from CloudFront only'
          : 'Allow HTTP access from CloudFront only',
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
          defaultAction: elbv2.ListenerAction.fixedResponse(allowDirectAlbAccess ? 404 : 403, {
            contentType: 'text/plain',
            messageBody: allowDirectAlbAccess ? 'Not Found' : 'Forbidden',
          }),
        })
      : this.alb.addListener('HttpListener', {
          port: 80,
          open: false,
          defaultAction: elbv2.ListenerAction.fixedResponse(allowDirectAlbAccess ? 404 : 403, {
            contentType: 'text/plain',
            messageBody: allowDirectAlbAccess ? 'Not Found' : 'Forbidden',
          }),
        });

    // ────────────────────────────────────────────────
    // ECS クラスター
    // Container Insights を有効化してメトリクスを収集
    // ────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    cdk.Tags.of(this.cluster).add('Name', buildResourceName(envName, 'cluster'));

    // ────────────────────────────────────────────────
    // Fargate タスク定義
    // CPU・メモリは環境設定から取得
    // ────────────────────────────────────────────────
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: envConfig.taskCpu,
      memoryLimitMiB: envConfig.taskMemoryMiB,
    });

    // API サービスコンテナを追加
    const container = this.taskDefinition.addContainer('api-service', {
      containerName: 'api-service',
      image: ecs.ContainerImage.fromEcrRepository(appRepository, appImageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: buildResourceName(envName, 'api-service'),
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        APP_ENV: envName,
        EVENT_QUEUE_URL: eventQueue.queueUrl,
        DB_SECRET_ARN: auroraSecret.secretArn,
      },
    });
    auroraSecret.grantRead(this.taskDefinition.taskRole);

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
    // コンテナポートマッピング（管理 API: 8080、アプリ API: 8081）
    container.addPortMappings(
      { containerPort: 8080 },
      { containerPort: 8081 },
    );

    // ────────────────────────────────────────────────
    // ECS サービス用セキュリティグループ
    // ALB SG からの API ポートのみ許可
    // ────────────────────────────────────────────────
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      description: 'Security group for ECS Fargate service',
    });
    // ALB から ECS Service への Ingress は listener.addTargets() によって自動追加される

    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromService', {
      groupId: auroraSecurityGroup.securityGroupId,
      sourceSecurityGroupId: serviceSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      description: 'Allow MySQL access from ECS Service',
    });

    // ────────────────────────────────────────────────
    // ECS Fargate サービス
    // プライベートサブネット（PRIVATE_WITH_EGRESS）に配置
    // ────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: envConfig.minTaskCount,
      assignPublicIp: false,
      securityGroups: [serviceSg],
      // stg/prod の 2 タスク高可用性を維持するため、ローリングデプロイ中も最小稼働数を保持する
      minHealthyPercent: envConfig.minTaskCount >= 2 ? 100 : 50,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(90),
      // デプロイ失敗時に自動ロールバック
      circuitBreaker: { rollback: true },
    });
    cdk.Tags.of(this.service).add('Name', buildResourceName(envName, 'service'));

    const apiListenerConditions = (pathPattern: string): elbv2.ListenerCondition[] => {
      const conditions = [elbv2.ListenerCondition.pathPatterns([pathPattern])];
      if (!allowDirectAlbAccess) {
        conditions.push(
          elbv2.ListenerCondition.httpHeader(
            envConfig.cloudFrontOriginVerifyHeaderName,
            [envConfig.cloudFrontOriginVerifyHeaderValue],
          ),
        );
      }
      return conditions;
    };

    const mgtApiTargetOptions: elbv2.AddApplicationTargetsProps = {
      priority: 10,
      conditions: apiListenerConditions('/mgt-api/*'),
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/actuator/health',
        port: '8080',
        protocol: elbv2.Protocol.HTTP,
      },
    };

    const appApiTargetOptions: elbv2.AddApplicationTargetsProps = {
      priority: 20,
      conditions: apiListenerConditions('/app-api/*'),
      port: 8081,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/actuator/health',
        port: '8081',
        protocol: elbv2.Protocol.HTTP,
      },
    };

    // ALB ターゲットグループにサービスを登録
    listener.addTargets('MgtApiTarget', mgtApiTargetOptions);
    listener.addTargets('AppApiTarget', appApiTargetOptions);

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
      description: 'ALB DNS name used by EdgeStack as the CloudFront API origin.',
    });

    if (!hasAlbCertificate) {
      new cdk.CfnOutput(this, 'AlbTlsDisabledNotice', {
        value: 'Set certificateArn in environments.ts to enable HTTPS (443) on ALB origin',
      });
    }

  }
}
