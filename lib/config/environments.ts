import { EnvConfig } from './env-config';

/**
 * 各環境の設定定義
 * CDK_DEPLOY_ACCOUNT 環境変数が未設定の場合は CDK_DEFAULT_ACCOUNT を使用し、
 * それも未設定の場合はプレースホルダー値を使用する
 */
export const environments: Record<string, EnvConfig> = {
  // ────────────────────────────────────────────────
  // 開発環境（コスト最小構成）
  // ────────────────────────────────────────────────
  dev: {
    // ============================================================
    // よく変更する項目
    // ============================================================
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '825269749877', // 部署先 AWS アカウント ID
    region: 'ap-northeast-1', // メインのデプロイリージョン
    taskCpu: 256, // ECS Fargate タスク CPU
    taskMemoryMiB: 512, // ECS Fargate タスクメモリ（MiB）
    minTaskCount: 1, // ECS サービス最小タスク数
    maxTaskCount: 2, // ECS サービス最大タスク数
    enableBackup: false, // AWS Backup 有効化フラグ
    enableAthena: true, // Athena（ログ分析基盤）有効化フラグ
    // dev 初回構築中は destroy で S3 / Aurora を削除する。有効データ投入後は true に変更してから運用する。
    retainDataResources: false,
    enableInspector: false, // Inspector（脆弱性スキャン）有効化フラグ
    enableXray: true, // X-Ray（分散トレーシング）有効化フラグ
    enableEventProcessing: false, // EventBridge ルール有効化フラグ
    mediaBucketName: 'asahimyapp-media-assets-dev', // メディアアセット格納用 S3 バケット名
    athenaResultsBucketName: 'asahimyapp-athena-results-dev', // Athena クエリ結果出力用 S3 バケット名
    actionLogRawBucketName: 'asahimyapp-action-log-raw-dev', // 行動ログ Raw バケット名
    actionLogRawPrefix: 'raw/action-log/', // 行動ログ Raw プレフィックス
    actionLogProjectionStartYear: 2026, // 行動ログ Athena Partition Projection 開始年
    actionLogProjectionEndYear: 2035, // 行動ログ Athena Partition Projection 終了年
    actionLogIntermediateBucketName: 'asahimyapp-action-log-intermediate-dev', // 行動ログ Athena 中間成果物バケット名
    actionLogIntermediatePrefix: 'intermediate/action-log/', // 行動ログ Athena 中間成果物プレフィックス
    actionLogDeliveryBucketName: 'mti-log-delivery-asahilife-dev', // 行動ログ Delivery TSV 出力用 S3 バケット名
    actionLogDeliveryEventsPrefix: 'events/', // 行動ログ Events Delivery TSV 出力用 S3 プレフィックス
    actionLogDeliveryAttributesPrefix: 'attributes/', // 行動ログ Attributes Delivery TSV 出力用 S3 プレフィックス
    actionLogDeliveryRetentionDays: 7, // 行動ログ Delivery TSV 保持日数
    actionLogAthenaDatabaseName: 'action_log_dev', // 行動ログ Athena データベース名
    actionLogRawTableName: 'action_log_raw', // 行動ログ Raw 外部テーブル名
    adminSiteBucketName: 'asahimyapp-admin-site-dev', // 管理画面静的サイト用 S3 バケット名
    cloudTrailBucketName: 'asahimyapp-cloudtrail-logs-dev', // CloudTrail ログ保存用 S3 バケット名
    videoUploadPrefix: 'uploads/', // 動画アップロード入力プレフィックス
    mediaOutputPrefix: 'public/', // CloudFront 配信用公開アセットプレフィックス
    edgeRegion: 'us-east-1', // EdgeStack デプロイ先リージョン（CloudFront/WAF/ACM 必須）
    edgeDomainName: 'PLACEHOLDER_EDGE_DOMAIN_NAME', // CloudFront カスタムドメイン名
    edgeCertificateArn: 'PLACEHOLDER_EDGE_CERTIFICATE_ARN', // us-east-1 の ACM 証明書 ARN
    cloudFrontOriginVerifyHeaderName: 'X-Origin-Verify', // CloudFront から ALB へ付与する Origin 検証ヘッダー名
    cloudFrontOriginVerifyHeaderValue: 'PLACEHOLDER_ORIGIN_VERIFY_HEADER_VALUE', // CloudFront Origin 検証ヘッダー値
    cloudFrontOriginPrefixListId: 'pl-58a04531', // ap-northeast-1 の CloudFront Origin-Facing マネージド Prefix List ID

    // ============================================================
    // 詳細設定（通常は既定値のまま運用）
    // ============================================================
    s3GatewayEndpointEnabled: true, // S3 Gateway Endpoint 有効化フラグ
    interfaceVpcEndpointsEnabled: false, // VPC Interface Endpoint 有効化フラグ（dev は固定費を抑制）
    dbInstanceClass: 'db.t4g.medium', // Aurora の DB インスタンスクラス
    auroraMultiAz: false, // Aurora リーダー追加による Multi-AZ 構成フラグ
    domainName: 'PLACEHOLDER_DOMAIN_NAME', // 既存ドメイン名（将来連携用プレースホルダー）
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN', // 既存 ACM 証明書 ARN（将来連携用プレースホルダー）
    enableWaf: false, // EdgeStack の CloudFront WAF を有効化するフラグ（dev は無効）
    enableCloudTrail: false, // CloudTrail 有効化フラグ
    enableGuardDuty: false, // GuardDuty 有効化フラグ
    enableSecurityHub: false, // Security Hub 有効化フラグ
    eventBusName: '', // EventBridge カスタムバス名（空なら自動命名）
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT', // MediaConvert エンドポイント
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN', // MediaConvert 実行ロール ARN
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID', // Push 配信アプリケーション ID
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN', // Push 資格情報の Secrets Manager ARN
    eventProcessorTimeoutSec: 30, // EventProcessor Lambda タイムアウト（秒）
    eventProcessorMemoryMiB: 256, // EventProcessor Lambda メモリ（MiB）
    eventQueueVisibilityTimeoutSec: 120, // メインキュー可視性タイムアウト（秒）
    eventQueueRetentionDays: 4, // メインキュー/DLQ メッセージ保持期間（日）
    eventDlqMaxReceiveCount: 3, // DLQ へ移送するまでの最大再試行回数
    hostedZoneName: 'PLACEHOLDER_HOSTED_ZONE_NAME', // Route 53 ホストゾーン名
    hostedZoneId: 'PLACEHOLDER_HOSTED_ZONE_ID', // Route 53 ホストゾーン ID
    adminSiteDefaultRootObject: 'index.html', // 管理画面静的サイトのデフォルトファイル
  },

  // ────────────────────────────────────────────────
  // ステージング環境（本番に近い構成）
  // ────────────────────────────────────────────────
  stg: {
    // ============================================================
    // よく変更する項目
    // ============================================================
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012', // 部署先 AWS アカウント ID
    region: 'ap-northeast-1', // メインのデプロイリージョン
    taskCpu: 512, // ECS Fargate タスク CPU
    taskMemoryMiB: 1024, // ECS Fargate タスクメモリ（MiB）
    minTaskCount: 2, // ECS サービス最小タスク数
    maxTaskCount: 3, // ECS サービス最大タスク数
    enableBackup: true, // AWS Backup 有効化フラグ
    enableAthena: true, // Athena（ログ分析基盤）有効化フラグ
    retainDataResources: true, // データ保護のため S3 / Aurora は Stack 削除後も保持する
    enableInspector: true, // Inspector（脆弱性スキャン）有効化フラグ
    enableXray: true, // X-Ray（分散トレーシング）有効化フラグ
    enableEventProcessing: false, // EventBridge ルール有効化フラグ
    mediaBucketName: 'asahimyapp-media-assets-stg', // メディアアセット格納用 S3 バケット名
    athenaResultsBucketName: 'asahimyapp-athena-results-stg', // Athena クエリ結果出力用 S3 バケット名
    actionLogRawBucketName: 'asahimyapp-action-log-raw-stg', // 行動ログ Raw バケット名（外部表 location）
    actionLogRawPrefix: 'raw/action-log/', // 行動ログ Raw プレフィックス
    actionLogProjectionStartYear: 2026, // 行動ログ Athena Partition Projection 開始年
    actionLogProjectionEndYear: 2035, // 行動ログ Athena Partition Projection 終了年
    actionLogIntermediateBucketName: 'asahimyapp-action-log-intermediate-stg', // 行動ログ Athena 中間成果物バケット名
    actionLogIntermediatePrefix: 'intermediate/action-log/', // 行動ログ Athena 中間成果物プレフィックス
    actionLogDeliveryCustomerAccountId: 'PLACEHOLDER_ACTION_LOG_DELIVERY_CUSTOMER_ACCOUNT_ID', // 顧客 AWS アカウント ID
    actionLogDeliveryExternalId: 'PLACEHOLDER_ACTION_LOG_DELIVERY_EXTERNAL_ID', // 顧客向け Cross-Account Role ExternalId
    actionLogDeliveryEventsPrefix: 'events/', // 行動ログ Events Delivery TSV 出力用 S3 プレフィックス
    actionLogDeliveryAttributesPrefix: 'attributes/', // 行動ログ Attributes Delivery TSV 出力用 S3 プレフィックス
    actionLogDeliveryRetentionDays: 30, // 行動ログ Delivery TSV 保持日数
    actionLogAthenaDatabaseName: 'action_log_stg', // 行動ログ Athena データベース名
    actionLogRawTableName: 'action_log_raw', // 行動ログ Raw 外部テーブル名
    actionLogDeliveryBucketName: 'mti-log-delivery-asahilife-stg', // 行動ログ Delivery TSV 出力用 S3 バケット名
    adminSiteBucketName: 'asahimyapp-admin-site-stg', // 管理画面静的サイト用 S3 バケット名
    cloudTrailBucketName: 'asahimyapp-cloudtrail-logs-stg', // CloudTrail ログ保存用 S3 バケット名
    videoUploadPrefix: 'uploads/', // 動画アップロード入力プレフィックス
    mediaOutputPrefix: 'public/', // CloudFront 配信用公開アセットプレフィックス
    edgeRegion: 'us-east-1', // EdgeStack デプロイ先リージョン（CloudFront/WAF/ACM 必須）
    edgeDomainName: 'PLACEHOLDER_EDGE_DOMAIN_NAME', // CloudFront カスタムドメイン名
    edgeCertificateArn: 'PLACEHOLDER_EDGE_CERTIFICATE_ARN', // us-east-1 の ACM 証明書 ARN
    cloudFrontOriginVerifyHeaderName: 'X-Origin-Verify', // CloudFront から ALB へ付与する Origin 検証ヘッダー名
    cloudFrontOriginVerifyHeaderValue: 'PLACEHOLDER_ORIGIN_VERIFY_HEADER_VALUE', // CloudFront Origin 検証ヘッダー値
    cloudFrontOriginPrefixListId: 'pl-58a04531', // ap-northeast-1 の CloudFront Origin-Facing マネージド Prefix List ID

    // ============================================================
    // 詳細設定（通常は既定値のまま運用）
    // ============================================================
    s3GatewayEndpointEnabled: true, // S3 Gateway Endpoint 有効化フラグ
    interfaceVpcEndpointsEnabled: true, // VPC Interface Endpoint 有効化フラグ（stg は有効）
    dbInstanceClass: 'db.t4g.large', // Aurora の DB インスタンスクラス
    auroraMultiAz: true, // Aurora リーダー追加による Multi-AZ 構成フラグ
    domainName: 'PLACEHOLDER_DOMAIN_NAME', // 既存ドメイン名（将来連携用プレースホルダー）
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN', // 既存 ACM 証明書 ARN（将来連携用プレースホルダー）
    enableWaf: true, // EdgeStack の CloudFront WAF を有効化するフラグ（stg は有効）
    enableCloudTrail: true, // CloudTrail 有効化フラグ
    enableGuardDuty: true, // GuardDuty 有効化フラグ
    enableSecurityHub: false, // Security Hub 有効化フラグ（stg はコスト最適化で無効）
    eventBusName: '', // EventBridge カスタムバス名（空なら自動命名）
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT', // MediaConvert エンドポイント
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN', // MediaConvert 実行ロール ARN
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID', // Push 配信アプリケーション ID
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN', // Push 資格情報の Secrets Manager ARN
    eventProcessorTimeoutSec: 60, // EventProcessor Lambda タイムアウト（秒）
    eventProcessorMemoryMiB: 512, // EventProcessor Lambda メモリ（MiB）
    eventQueueVisibilityTimeoutSec: 180, // メインキュー可視性タイムアウト（秒）
    eventQueueRetentionDays: 14, // メインキュー/DLQ メッセージ保持期間（日）
    eventDlqMaxReceiveCount: 5, // DLQ へ移送するまでの最大再試行回数
    hostedZoneName: 'PLACEHOLDER_HOSTED_ZONE_NAME', // Route 53 ホストゾーン名
    hostedZoneId: 'PLACEHOLDER_HOSTED_ZONE_ID', // Route 53 ホストゾーン ID
    adminSiteDefaultRootObject: 'index.html', // 管理画面静的サイトのデフォルトファイル
  },

  // ────────────────────────────────────────────────
  // 本番環境（高可用性・高信頼性構成）
  // ────────────────────────────────────────────────
  prod: {
    // ============================================================
    // よく変更する項目
    // ============================================================
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012', // 部署先 AWS アカウント ID
    region: 'ap-northeast-1', // メインのデプロイリージョン
    taskCpu: 512, // ECS Fargate タスク CPU
    taskMemoryMiB: 1024, // ECS Fargate タスクメモリ（MiB）
    minTaskCount: 2, // ECS サービス最小タスク数
    maxTaskCount: 3, // ECS サービス最大タスク数
    enableBackup: true, // AWS Backup 有効化フラグ
    enableAthena: true, // Athena（ログ分析基盤）有効化フラグ
    retainDataResources: true, // データ保護のため S3 / Aurora は Stack 削除後も保持する
    enableInspector: true, // Inspector（脆弱性スキャン）有効化フラグ
    enableXray: true, // X-Ray（分散トレーシング）有効化フラグ
    enableEventProcessing: false, // EventBridge ルール有効化フラグ
    mediaBucketName: 'asahimyapp-media-assets-prod', // メディアアセット格納用 S3 バケット名
    athenaResultsBucketName: 'asahimyapp-athena-results-prod', // Athena クエリ結果出力用 S3 バケット名
    actionLogRawBucketName: 'asahimyapp-action-log-raw-prod', // 行動ログ Raw バケット名（外部表 location）
    actionLogRawPrefix: 'raw/action-log/', // 行動ログ Raw プレフィックス
    actionLogProjectionStartYear: 2026, // 行動ログ Athena Partition Projection 開始年
    actionLogProjectionEndYear: 2035, // 行動ログ Athena Partition Projection 終了年
    actionLogIntermediateBucketName: 'asahimyapp-action-log-intermediate-prod', // 行動ログ Athena 中間成果物バケット名
    actionLogIntermediatePrefix: 'intermediate/action-log/', // 行動ログ Athena 中間成果物プレフィックス
    actionLogDeliveryCustomerAccountId: 'PLACEHOLDER_ACTION_LOG_DELIVERY_CUSTOMER_ACCOUNT_ID', // 顧客 AWS アカウント ID
    actionLogDeliveryExternalId: 'PLACEHOLDER_ACTION_LOG_DELIVERY_EXTERNAL_ID', // 顧客向け Cross-Account Role ExternalId
    actionLogDeliveryEventsPrefix: 'events/', // 行動ログ Events Delivery TSV 出力用 S3 プレフィックス
    actionLogDeliveryAttributesPrefix: 'attributes/', // 属性ログ Attributes Delivery TSV 出力用 S3 プレフィックス
    actionLogDeliveryRetentionDays: 30, // 行動ログ Delivery TSV 保持日数
    actionLogAthenaDatabaseName: 'action_log_prod', // 行動ログ Athena データベース名
    actionLogRawTableName: 'action_log_raw', // 行動ログ Raw 外部テーブル名
    actionLogDeliveryBucketName: 'mti-log-delivery-asahilife-prod', // 行動ログ Delivery TSV 出力用 S3 バケット名
    adminSiteBucketName: 'asahimyapp-admin-site-prod', // 管理画面静的サイト用 S3 バケット名
    cloudTrailBucketName: 'asahimyapp-cloudtrail-logs-prod', // CloudTrail ログ保存用 S3 バケット名
    videoUploadPrefix: 'uploads/', // 動画アップロード入力プレフィックス
    mediaOutputPrefix: 'public/', // CloudFront 配信用公開アセットプレフィックス
    edgeRegion: 'us-east-1', // EdgeStack デプロイ先リージョン（CloudFront/WAF/ACM 必須）
    edgeDomainName: 'PLACEHOLDER_EDGE_DOMAIN_NAME', // CloudFront カスタムドメイン名
    edgeCertificateArn: 'PLACEHOLDER_EDGE_CERTIFICATE_ARN', // us-east-1 の ACM 証明書 ARN
    cloudFrontOriginVerifyHeaderName: 'X-Origin-Verify', // CloudFront から ALB へ付与する Origin 検証ヘッダー名
    cloudFrontOriginVerifyHeaderValue: 'PLACEHOLDER_ORIGIN_VERIFY_HEADER_VALUE', // CloudFront Origin 検証ヘッダー値
    cloudFrontOriginPrefixListId: 'pl-58a04531', // ap-northeast-1 の CloudFront Origin-Facing マネージド Prefix List ID

    // ============================================================
    // 詳細設定（通常は既定値のまま運用）
    // ============================================================
    s3GatewayEndpointEnabled: true, // S3 Gateway Endpoint 有効化フラグ
    interfaceVpcEndpointsEnabled: true, // VPC Interface Endpoint 有効化フラグ（prod は有効）
    dbInstanceClass: 'db.t4g.large', // Aurora の DB インスタンスクラス
    auroraMultiAz: true, // Aurora リーダー追加による Multi-AZ 構成フラグ
    domainName: 'PLACEHOLDER_DOMAIN_NAME', // 既存ドメイン名（将来連携用プレースホルダー）
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN', // 既存 ACM 証明書 ARN（将来連携用プレースホルダー）
    enableWaf: true, // EdgeStack の CloudFront WAF を有効化するフラグ（prod は有効）
    enableCloudTrail: true, // CloudTrail 有効化フラグ
    enableGuardDuty: true, // GuardDuty 有効化フラグ
    enableSecurityHub: true, // Security Hub 有効化フラグ
    eventBusName: '', // EventBridge カスタムバス名（空なら自動命名）
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT', // MediaConvert エンドポイント
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN', // MediaConvert 実行ロール ARN
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID', // Push 配信アプリケーション ID
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN', // Push 資格情報の Secrets Manager ARN
    eventProcessorTimeoutSec: 60, // EventProcessor Lambda タイムアウト（秒）
    eventProcessorMemoryMiB: 512, // EventProcessor Lambda メモリ（MiB）
    eventQueueVisibilityTimeoutSec: 180, // メインキュー可視性タイムアウト（秒）
    eventQueueRetentionDays: 14, // メインキュー/DLQ メッセージ保持期間（日）
    eventDlqMaxReceiveCount: 5, // DLQ へ移送するまでの最大再試行回数
    hostedZoneName: 'PLACEHOLDER_HOSTED_ZONE_NAME', // Route 53 ホストゾーン名
    hostedZoneId: 'PLACEHOLDER_HOSTED_ZONE_ID', // Route 53 ホストゾーン ID
    adminSiteDefaultRootObject: 'index.html', // 管理画面静的サイトのデフォルトファイル
  },
};
