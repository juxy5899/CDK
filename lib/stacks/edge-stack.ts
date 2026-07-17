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

    const { envName, envConfig } = props;

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
        name: buildResourceName(envName, 'cf-web-acl'),
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

      webAclArn = webAcl.attrArn;
    }

    this.webAclArn = webAclArn;

    const hasCustomDomain = !isPlaceholder(envConfig.edgeDomainName);
    const hasEdgeCertificate = !isPlaceholder(envConfig.edgeCertificateArn);
    const hasAlbOriginDomain = !isPlaceholder(envConfig.albOriginDomainName);
    const hasAlbCertificate = !isPlaceholder(envConfig.certificateArn);

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    if (hasAlbOriginDomain) {
      // API リクエストのみ ALB オリジンへ転送する
      // TODO: CloudFront オリジンリクエストにカスタムヘッダー（例: X-Origin-Verify）を付与する
      additionalBehaviors['api/*'] = {
        origin: new origins.HttpOrigin(envConfig.albOriginDomainName, {
          protocolPolicy: hasAlbCertificate
            ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
            : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      };
    }

    const baseDistributionProps: cloudfront.DistributionProps = {
      defaultRootObject: envConfig.adminSiteDefaultRootObject,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.adminSiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors,
      comment: buildResourceName(envName, 'edge-distribution'),
      webAclId: this.webAclArn,
    };

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
    // 管理画面静的配信をデフォルトにし、/api/* のみ ALB へルーティングする
    // ────────────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'Distribution', distributionProps);

    if (!envConfig.enableWaf) {
      new cdk.CfnOutput(this, 'WafDisabledNotice', {
        value: 'WAF is disabled by enableWaf=false for this environment',
      });
    }

    // Route 53 はドメイン情報確定時のみ作成する
    if (hasCustomDomain && hasEdgeCertificate && !isPlaceholder(envConfig.hostedZoneName) && !isPlaceholder(envConfig.hostedZoneId)) {
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

    if (!hasAlbOriginDomain) {
      new cdk.CfnOutput(this, 'AlbOriginDomainPlaceholderNotice', {
        value: 'Set albOriginDomainName in environments.ts to enable /api/* forwarding to ALB',
      });
    }

    if (hasAlbOriginDomain && !hasAlbCertificate) {
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
