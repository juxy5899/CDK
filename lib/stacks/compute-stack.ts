import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
  appApiRepository: ecr.Repository;
  mgtApiRepository: ecr.Repository;
  mediaBucket: s3.IBucket;
  actionLogRawBucket: s3.IBucket;
  accessLogBucket?: s3.IBucket;
  appApiImageTag: string;
  mgtApiImageTag: string;
  strictValidation: boolean;
  auroraSecret: secretsmanager.ISecret;
  auroraSecurityGroup: ec2.ISecurityGroup;
  eventQueue: sqs.IQueue;
}

interface ApiServiceRuntimeAccess {
  database: boolean;
  eventQueueSend: boolean;
  mediaBucket: boolean;
  actionLogRawBucket: boolean;
}

export class ComputeStack extends cdk.Stack {
  /** Application Load Balancer */
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** ECS クラスター */
  public readonly cluster: ecs.Cluster;
  /** アプリ API Fargate タスク定義 */
  public readonly appApiTaskDefinition?: ecs.FargateTaskDefinition;
  /** 管理 API Fargate タスク定義 */
  public readonly mgtApiTaskDefinition: ecs.FargateTaskDefinition;
  /** アプリ API ECS Fargate サービス */
  public readonly appApiService?: ecs.FargateService;
  /** 管理 API ECS Fargate サービス */
  public readonly mgtApiService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const {
      envName,
      envConfig,
      vpc,
      appApiRepository,
      mgtApiRepository,
      mediaBucket,
      actionLogRawBucket,
      accessLogBucket,
      appApiImageTag,
      mgtApiImageTag,
      strictValidation,
      auroraSecret,
      auroraSecurityGroup,
      eventQueue,
    } = props;

    // ────────────────────────────────────────────────
    // ALB セキュリティグループ
    // CloudFront Origin-Facing プレフィックスリストからのアクセスのみ許可
    // ────────────────────────────────────────────────
    const hasAlbCertificate = !isPlaceholder(envConfig.certificateArn);
    const hasOriginVerifyHeader = !isPlaceholder(envConfig.cloudFrontOriginVerifyHeaderValue);
    const hasAppApiImageTag = !isPlaceholder(appApiImageTag);
    const hasMgtApiImageTag = !isPlaceholder(mgtApiImageTag);
    const allowDirectAlbAccess = envName === 'dev';

    if (strictValidation && envName !== 'dev' && !hasAlbCertificate) {
      throw new Error(
        `${envName} requires certificateArn to enable HTTPS between CloudFront and ALB`,
      );
    }

    if (strictValidation && envName !== 'dev' && !hasOriginVerifyHeader) {
      throw new Error(
        `${envName} requires cloudFrontOriginVerifyHeaderValue for ALB origin verification`,
      );
    }

    if (strictValidation && envName !== 'dev' && (!hasAppApiImageTag || !hasMgtApiImageTag)) {
      throw new Error(
        `${envName} requires -c appApiImageTag=<immutable-image-tag> and -c mgtApiImageTag=<immutable-image-tag> for ComputeStack deployment`,
      );
    }

    if (
      envName !== 'dev' &&
      (!hasAlbCertificate || !hasOriginVerifyHeader || !hasAppApiImageTag || !hasMgtApiImageTag)
    ) {
      cdk.Annotations.of(this).addWarning(
        'ComputeStack has placeholder deployment inputs. Use -c strictComputeValidation=true with certificateArn, originVerifyHeaderValue, appApiImageTag, and mgtApiImageTag before deploying Compute/Edge.',
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
    if (envConfig.enableAccessLogs) {
      if (accessLogBucket === undefined) {
        throw new Error('accessLogBucket is required when enableAccessLogs=true');
      }
      this.alb.logAccessLogs(accessLogBucket, envConfig.albAccessLogPrefix);
    }

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
      clusterName: buildResourceName(envName, 'cluster'),
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    cdk.Tags.of(this.cluster).add('Name', buildResourceName(envName, 'cluster'));

    const createTaskDefinition = (
      id: string,
      serviceName: string,
      repository: ecr.Repository,
      imageTag: string,
      containerPort: number,
      access: ApiServiceRuntimeAccess,
    ): ecs.FargateTaskDefinition => {
      const taskDefinition = new ecs.FargateTaskDefinition(this, id, {
        cpu: envConfig.taskCpu,
        memoryLimitMiB: envConfig.taskMemoryMiB,
      });
      const serviceLogGroup = new logs.LogGroup(this, `${id}LogGroup`, {
        logGroupName: `/aws/ecs/${buildResourceName(envName, serviceName)}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      const container = taskDefinition.addContainer(serviceName, {
        containerName: serviceName,
        image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: serviceLogGroup,
          streamPrefix: buildResourceName(envName, serviceName),
        }),
        environment: {
          APP_ENV: envName,
          SPRING_PROFILES_ACTIVE: envName,
          ...(access.mediaBucket || access.actionLogRawBucket
            ? { APP_AWS_REGION: this.region }
            : {}),
          ...(access.eventQueueSend ? { EVENT_QUEUE_URL: eventQueue.queueUrl } : {}),
          ...(access.mediaBucket
            ? {
                APP_MEDIA_S3_BUCKET: mediaBucket.bucketName,
                APP_MEDIA_S3_UPLOAD_PREFIX: envConfig.videoUploadPrefix,
                APP_MEDIA_S3_PUBLIC_PREFIX: envConfig.mediaOutputPrefix,
              }
            : {}),
          ...(access.actionLogRawBucket
            ? {
                APP_ACTION_LOG_RAW_S3_BUCKET: actionLogRawBucket.bucketName,
                APP_ACTION_LOG_RAW_S3_PREFIX: envConfig.actionLogRawPrefix,
              }
            : {}),
        },
        secrets: access.database
          ? {
              DB_HOST: ecs.Secret.fromSecretsManager(auroraSecret, 'host'),
              DB_PORT: ecs.Secret.fromSecretsManager(auroraSecret, 'port'),
              DB_NAME: ecs.Secret.fromSecretsManager(auroraSecret, 'dbname'),
              DB_USERNAME: ecs.Secret.fromSecretsManager(auroraSecret, 'username'),
              DB_PASSWORD: ecs.Secret.fromSecretsManager(auroraSecret, 'password'),
            }
          : undefined,
      });
      container.addPortMappings({ containerPort });
      if (access.eventQueueSend) {
        eventQueue.grantSendMessages(taskDefinition.taskRole);
      }
      if (access.mediaBucket) {
        taskDefinition.addToTaskRolePolicy(
          new iam.PolicyStatement({
            sid: 'MediaBucketObjectAccess',
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:PutObject'],
            resources: [mediaBucket.arnForObjects('*')],
          }),
        );
      }
      if (access.actionLogRawBucket) {
        taskDefinition.addToTaskRolePolicy(
          new iam.PolicyStatement({
            sid: 'ActionLogRawBucketWriteAccess',
            effect: iam.Effect.ALLOW,
            actions: ['s3:PutObject'],
            resources: [actionLogRawBucket.arnForObjects(`${envConfig.actionLogRawPrefix}*`)],
          }),
        );
      }

      if (envConfig.enableXray) {
        container.addEnvironment('AWS_XRAY_DAEMON_ADDRESS', '127.0.0.1:2000');
        const xrayLogGroup = new logs.LogGroup(this, `${id}XrayDaemonLogGroup`, {
          logGroupName: `/aws/ecs/${buildResourceName(envName, `${serviceName}-xray-daemon`)}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        });
        taskDefinition
          .addContainer(`${serviceName}-xray-daemon`, {
            containerName: `${serviceName}-xray-daemon`,
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:3.3.11'),
            essential: false,
            logging: ecs.LogDrivers.awsLogs({
              logGroup: xrayLogGroup,
              streamPrefix: buildResourceName(envName, `${serviceName}-xray-daemon`),
            }),
          })
          .addPortMappings({
            containerPort: 2000,
            protocol: ecs.Protocol.UDP,
          });
        taskDefinition.addToTaskRolePolicy(
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

      return taskDefinition;
    };

    this.mgtApiTaskDefinition = createTaskDefinition(
      'MgtApiTaskDef',
      'mgt-api',
      mgtApiRepository,
      mgtApiImageTag,
      8080,
      {
        database: true,
        eventQueueSend: true,
        mediaBucket: true,
        actionLogRawBucket: true,
      },
    );
    // app-api is temporarily excluded from ComputeStack deployment.
    // this.appApiTaskDefinition = createTaskDefinition('AppApiTaskDef', 'app-api', appApiRepository, appApiImageTag, 8081, {
    //   database: true,
    //   eventQueueSend: false,
    //   mediaBucket: false,
    //   actionLogRawBucket: false,
    // });

    // ────────────────────────────────────────────────
    // ECS サービス用セキュリティグループ
    // ALB SG からの API ポートのみ許可
    // ────────────────────────────────────────────────
    const mgtApiServiceSg = new ec2.SecurityGroup(this, 'MgtApiServiceSg', {
      vpc,
      description: 'Security group for mgt-api ECS Fargate service',
    });
    mgtApiServiceSg.addIngressRule(
      albSg,
      ec2.Port.tcp(8080),
      'Allow management API traffic from ALB',
    );

    // const appApiServiceSg = new ec2.SecurityGroup(this, 'AppApiServiceSg', {
    //   vpc,
    //   description: 'Security group for app-api ECS Fargate service',
    // });
    // appApiServiceSg.addIngressRule(albSg, ec2.Port.tcp(8081), 'Allow app API traffic from ALB');

    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromMgtApiService', {
      groupId: auroraSecurityGroup.securityGroupId,
      sourceSecurityGroupId: mgtApiServiceSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      description: 'Allow MySQL access from mgt-api ECS Service',
    });
    // new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromAppApiService', {
    //   groupId: auroraSecurityGroup.securityGroupId,
    //   sourceSecurityGroupId: appApiServiceSg.securityGroupId,
    //   ipProtocol: 'tcp',
    //   fromPort: 3306,
    //   toPort: 3306,
    //   description: 'Allow MySQL access from app-api ECS Service',
    // });

    // ────────────────────────────────────────────────
    // ECS Fargate サービス
    // プライベートサブネット（PRIVATE_WITH_EGRESS）に配置
    // ────────────────────────────────────────────────
    this.mgtApiService = new ecs.FargateService(this, 'MgtApiService', {
      cluster: this.cluster,
      serviceName: buildResourceName(envName, 'mgt-api-service'),
      taskDefinition: this.mgtApiTaskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: envConfig.mgtApiMinTaskCount,
      assignPublicIp: false,
      securityGroups: [mgtApiServiceSg],
      // stg/prod の 2 タスク高可用性を維持するため、ローリングデプロイ中も最小稼働数を保持する
      minHealthyPercent: envConfig.mgtApiMinTaskCount >= 2 ? 100 : 50,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(90),
      // デプロイ失敗時に自動ロールバック
      circuitBreaker: { rollback: true },
    });
    cdk.Tags.of(this.mgtApiService).add('Name', buildResourceName(envName, 'mgt-api-service'));

    // this.appApiService = new ecs.FargateService(this, 'AppApiService', {
    //   cluster: this.cluster,
    //   taskDefinition: this.appApiTaskDefinition,
    //   vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    //   desiredCount: envConfig.appApiMinTaskCount,
    //   assignPublicIp: false,
    //   securityGroups: [appApiServiceSg],
    //   minHealthyPercent: envConfig.appApiMinTaskCount >= 2 ? 100 : 50,
    //   maxHealthyPercent: 200,
    //   healthCheckGracePeriod: cdk.Duration.seconds(90),
    //   circuitBreaker: { rollback: true },
    // });
    // cdk.Tags.of(this.appApiService).add('Name', buildResourceName(envName, 'app-api-service'));

    const apiListenerConditions = (pathPattern: string): elbv2.ListenerCondition[] => {
      const conditions = [elbv2.ListenerCondition.pathPatterns([pathPattern])];
      if (!allowDirectAlbAccess) {
        conditions.push(
          elbv2.ListenerCondition.httpHeader(envConfig.cloudFrontOriginVerifyHeaderName, [
            envConfig.cloudFrontOriginVerifyHeaderValue,
          ]),
        );
      }
      return conditions;
    };

    const mgtApiTargetOptions: elbv2.AddApplicationTargetsProps = {
      priority: 10,
      conditions: apiListenerConditions('/mgt-api/*'),
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.mgtApiService],
      healthCheck: {
        path: '/mgt-api/actuator/health',
        port: '8080',
        protocol: elbv2.Protocol.HTTP,
      },
    };

    // const appApiTargetOptions: elbv2.AddApplicationTargetsProps = {
    //   priority: 20,
    //   conditions: apiListenerConditions('/app-api/*'),
    //   port: 8081,
    //   protocol: elbv2.ApplicationProtocol.HTTP,
    //   targets: [this.appApiService],
    //   healthCheck: {
    //     path: '/app-api/actuator/health',
    //     port: '8081',
    //     protocol: elbv2.Protocol.HTTP,
    //   },
    // };

    // ALB ターゲットグループにサービスを登録
    listener.addTargets('MgtApiTarget', mgtApiTargetOptions);
    // listener.addTargets('AppApiTarget', appApiTargetOptions);

    // ────────────────────────────────────────────────
    // Application Auto Scaling
    // CPU・メモリ使用率に応じてタスク数をスケール
    // ────────────────────────────────────────────────
    const configureScaling = (
      idPrefix: string,
      service: ecs.FargateService,
      minTaskCount: number,
      maxTaskCount: number,
    ): void => {
      const scaling = service.autoScaleTaskCount({
        minCapacity: minTaskCount,
        maxCapacity: maxTaskCount,
      });

      scaling.scaleOnCpuUtilization(`${idPrefix}CpuScaleOut`, {
        targetUtilizationPercent: 70,
        scaleOutCooldown: cdk.Duration.seconds(300),
        scaleInCooldown: cdk.Duration.seconds(300),
      });

      scaling.scaleOnMemoryUtilization(`${idPrefix}MemScaleOut`, {
        targetUtilizationPercent: 80,
        scaleOutCooldown: cdk.Duration.seconds(300),
        scaleInCooldown: cdk.Duration.seconds(300),
      });
    };

    configureScaling(
      'MgtApi',
      this.mgtApiService,
      envConfig.mgtApiMinTaskCount,
      envConfig.mgtApiMaxTaskCount,
    );
    // configureScaling('AppApi', this.appApiService, envConfig.appApiMinTaskCount, envConfig.appApiMaxTaskCount);

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
