import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName, isPlaceholder } from '../config/env-config';

export interface EdgeStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  albOriginDomainName: string;
  strictValidation: boolean;
}

/**
 * Edge リソース専用スタック
 * CloudFront スコープの WAF と ACM 証明書を扱うため、app.ts 側で us-east-1 を明示指定してデプロイする。
 */
export class EdgeStack extends cdk.Stack {
  /** 管理画面静的ホスティング用バケット */
  public readonly adminSiteBucket: s3.Bucket;

  /** CloudFront ディストリビューション */
  public readonly distribution: cloudfront.Distribution;

  /** CloudFront 用 WAF WebACL ARN（WAF 無効時は undefined） */
  public readonly webAclArn: string | undefined;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const { envName, envConfig, albOriginDomainName, strictValidation } = props;
    // Media bucket policy は DataStack で明示管理するため、imported bucket への自動 policy 更新警告のみ抑止する。
    cdk.Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
      'Media bucket policy is managed explicitly in DataStack for the public media prefix.',
    );

    // ────────────────────────────────────────────────
    // 管理画面静的ホスティング用 S3
    // CloudFront 経由公開を前提にし、バケットの直接公開は無効化する
    // ────────────────────────────────────────────────
    this.adminSiteBucket = new s3.Bucket(this, 'AdminSiteBucket', {
      bucketName: envConfig.adminSiteBucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    let webAclArn: string | undefined;

    if (envConfig.enableWaf) {
      // ────────────────────────────────────────────────
      // CloudFront 用 WAF（CLOUDFRONT スコープ）
      // マネージドルールで一般的な攻撃を検知・遮断する
      // ────────────────────────────────────────────────
      const webAcl = new wafv2.CfnWebACL(this, 'CloudFrontWebAcl', {
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: buildResourceName(envName, 'cf-web-acl-metric'),
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'AWSManagedRulesCommonRuleSet',
            priority: 10,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'AWSManagedRulesCommonRuleSet',
              sampledRequestsEnabled: true,
            },
          },
          {
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
            priority: 20,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesKnownBadInputsRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      cdk.Tags.of(webAcl).add('Name', buildResourceName(envName, 'cf-web-acl'));

      webAclArn = webAcl.attrArn;
    }

    this.webAclArn = webAclArn;

    const hasCustomDomain = !isPlaceholder(envConfig.edgeDomainName);
    const hasEdgeCertificate = !isPlaceholder(envConfig.edgeCertificateArn);
    const hasAlbCertificate = !isPlaceholder(envConfig.certificateArn);
    const hasOriginVerifyHeader = !isPlaceholder(envConfig.cloudFrontOriginVerifyHeaderValue);

    // ────────────────────────────────────────────────
    // Edge デプロイ入力検証
    // stg/prod は CloudFront から ALB まで HTTPS と Origin 検証ヘッダーを前提にする
    // ────────────────────────────────────────────────
    if (strictValidation && envName !== 'dev' && !hasAlbCertificate) {
      throw new Error(
        `${envName} requires certificateArn to enforce HTTPS_ONLY from CloudFront to ALB`,
      );
    }

    if (strictValidation && envName !== 'dev' && !hasOriginVerifyHeader) {
      throw new Error(
        `${envName} requires cloudFrontOriginVerifyHeaderValue for ALB origin verification`,
      );
    }

    // strictValidation=false の段階構築でも、本番系の未確定入力は CloudFormation warning として残す
    if (envName !== 'dev' && (!hasAlbCertificate || !hasOriginVerifyHeader)) {
      cdk.Annotations.of(this).addWarning(
        'EdgeStack has placeholder ALB origin inputs. Use -c strictComputeValidation=true with certificateArn and originVerifyHeaderValue before deploying Edge.',
      );
    }

    // ────────────────────────────────────────────────
    // ALB Origin
    // 証明書が未確定の dev は HTTP origin を許容し、本番系は HTTPS_ONLY へ切り替える
    // ────────────────────────────────────────────────
    const albOrigin = new origins.HttpOrigin(albOriginDomainName, {
      protocolPolicy: hasAlbCertificate
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: {
        [envConfig.cloudFrontOriginVerifyHeaderName]: envConfig.cloudFrontOriginVerifyHeaderValue,
      },
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Host ヘッダー透過により、CloudFront は ALB Origin の TLS 検証で Viewer Host を SNI として使用する
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    };

    const mediaOriginBucket = s3.Bucket.fromBucketAttributes(this, 'MediaOriginBucket', {
      bucketName: envConfig.mediaBucketName,
      bucketRegionalDomainName: `${envConfig.mediaBucketName}.s3.${envConfig.region}.amazonaws.com`,
    });
    const mediaOutputPathPattern = `${envConfig.mediaOutputPrefix.replace(/^\/+/, '')}*`;
    const mediaBehavior: cloudfront.BehaviorOptions = {
      origin: origins.S3BucketOrigin.withOriginAccessControl(mediaOriginBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(
        this,
        'MediaCorsResponseHeadersPolicy',
        {
          responseHeadersPolicyName: buildResourceName(envName, 'media-cors-response-headers'),
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
            accessControlAllowOrigins: ['*'],
            accessControlMaxAge: cdk.Duration.seconds(3600),
            originOverride: true,
          },
        },
      ),
    };

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      [mediaOutputPathPattern]: mediaBehavior,
      'app-api/*': apiBehavior,
      'mgt-api/*': apiBehavior,
    };

    // アクセスログは DataStack 側で作成された既存バケットを参照し、EdgeStack 側では所有しない
    const accessLogBucket = envConfig.enableAccessLogs
      ? s3.Bucket.fromBucketAttributes(this, 'AccessLogBucket', {
          bucketName: envConfig.accessLogBucketName,
          bucketRegionalDomainName: `${envConfig.accessLogBucketName}.s3.${envConfig.region}.amazonaws.com`,
        })
      : undefined;

    // ────────────────────────────────────────────────
    // 管理画面 SPA リライト
    // 拡張子のないパスを index.html に寄せ、CloudFront 配下でクライアントルーティングを成立させる
    // ────────────────────────────────────────────────
    const adminSiteSpaRewriteFunction = new cloudfront.Function(
      this,
      'AdminSiteSpaRewriteFunction',
      {
        code: cloudfront.FunctionCode.fromInline(`function handler(event) {
          var request = event.request;
          var uri = request.uri;
          var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);

          if (uri !== '/' && lastSegment.indexOf('.') === -1) {
            request.uri = '/${envConfig.adminSiteDefaultRootObject}';
          }

          return request;
        }`),
      },
    );

    const baseDistributionProps: cloudfront.DistributionProps = {
      defaultRootObject: envConfig.adminSiteDefaultRootObject,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.adminSiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: adminSiteSpaRewriteFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors,
      comment: buildResourceName(envName, 'edge-distribution'),
      webAclId: this.webAclArn,
      ...(envConfig.enableAccessLogs
        ? {
            enableLogging: true,
            logBucket: accessLogBucket,
            logFilePrefix: envConfig.cloudFrontAccessLogPrefix,
          }
        : {}),
    };

    // カスタムドメインと us-east-1 ACM 証明書がそろった環境だけ alias domain を有効化する
    const distributionProps: cloudfront.DistributionProps =
      hasCustomDomain && hasEdgeCertificate
        ? {
            ...baseDistributionProps,
            domainNames: [envConfig.edgeDomainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'EdgeCertificate',
              envConfig.edgeCertificateArn,
            ),
          }
        : baseDistributionProps;

    // ────────────────────────────────────────────────
    // CloudFront Distribution
    // 管理画面静的配信をデフォルトにし、API パスのみ ALB へルーティングする
    // ────────────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'Distribution', distributionProps);

    if (!envConfig.enableWaf) {
      new cdk.CfnOutput(this, 'WafDisabledNotice', {
        value: 'WAF is disabled by enableWaf=false for this environment',
      });
    }

    // Route 53 はドメイン情報確定時のみ作成する
    if (
      hasCustomDomain &&
      hasEdgeCertificate &&
      !isPlaceholder(envConfig.hostedZoneName) &&
      !isPlaceholder(envConfig.hostedZoneId)
    ) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        zoneName: envConfig.hostedZoneName,
        hostedZoneId: envConfig.hostedZoneId,
      });

      new route53.ARecord(this, 'EdgeAliasRecord', {
        zone: hostedZone,
        recordName: envConfig.edgeDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.distribution),
        ),
      });
    }

    if (!hasAlbCertificate) {
      new cdk.CfnOutput(this, 'AlbOriginHttpFallbackNotice', {
        value: 'Set certificateArn in environments.ts to enforce HTTPS_ONLY from CloudFront to ALB',
      });
    }

    if (!hasCustomDomain || !hasEdgeCertificate) {
      new cdk.CfnOutput(this, 'EdgeDomainPlaceholderNotice', {
        value:
          'Set edgeDomainName and edgeCertificateArn in environments.ts to enable CloudFront custom domain',
      });
    }
  }
}
