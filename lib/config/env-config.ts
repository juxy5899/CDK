// アプリケーション名定数
export const AppName = 'MTI-AsahimyappSystem';

/**
 * 環境設定インターフェース
 * 各環境（dev / stg / prod）固有のパラメータを定義する
 */
export interface EnvConfig {
  /** AWS アカウント ID */
  account: string;

  /** デプロイリージョン */
  region: string;

  /** S3 Gateway Endpoint の有効化 */
  s3GatewayEndpointEnabled: boolean;

  /** VPC Interface Endpoint の有効化（dev:false でコスト削減） */
  interfaceVpcEndpointsEnabled: boolean;

  /** Aurora インスタンスクラス文字列（例: 'db.t4g.large'） */
  dbInstanceClass: string;

  /** Aurora Multi-AZ の有効化 */
  auroraMultiAz: boolean;

  /** Fargate タスク CPU（vCPU x 1024） */
  taskCpu: 256 | 512 | 1024 | 2048 | 4096;

  /** Fargate タスクメモリ（MiB） */
  taskMemoryMiB: 512 | 1024 | 2048 | 3072 | 4096 | 8192 | 16384;

  /** app-api ECS 最小タスク数 */
  appApiMinTaskCount: number;

  /** app-api ECS 最大タスク数 */
  appApiMaxTaskCount: number;

  /** mgt-api ECS 最小タスク数 */
  mgtApiMinTaskCount: number;

  /** mgt-api ECS 最大タスク数 */
  mgtApiMaxTaskCount: number;

  /** API ECR リポジトリのタグ付きイメージ保持数 */
  apiTaggedImageRetentionCount: number;

  /** API ECR リポジトリのタグなしイメージ保持日数 */
  apiUntaggedImageRetentionDays: number;

  /** ドメイン名（未確定: 'PLACEHOLDER_DOMAIN_NAME'） */
  domainName: string;

  /** ACM 証明書 ARN（未確定） */
  certificateArn: string;

  /** WAF v2 の有効化（CLOUDFRONT スコープ、CloudFront にアタッチ） */
  enableWaf: boolean;

  /** CloudTrail 有効化 */
  enableCloudTrail: boolean;

  /** GuardDuty 有効化 */
  enableGuardDuty: boolean;

  /** Security Hub 有効化 */
  enableSecurityHub: boolean;

  /** AWS Backup 有効化 */
  enableBackup: boolean;

  /** Amazon Athena 有効化 */
  enableAthena: boolean;

  /** CloudFront / ALB アクセスログ有効化 */
  enableAccessLogs: boolean;

  /** データリソースを Stack 削除後も保持するか */
  retainDataResources: boolean;

  /** メディアアセット格納用 S3 バケット名 */
  mediaBucketName: string;

  /** Athena クエリ結果出力用 S3 バケット名 */
  athenaResultsBucketName: string;

  /** CloudFront / ALB アクセスログ保存用 S3 バケット名 */
  accessLogBucketName: string;

  /** CloudFront アクセスログ保存用 S3 プレフィックス */
  cloudFrontAccessLogPrefix: string;

  /** ALB アクセスログ保存用 S3 プレフィックス */
  albAccessLogPrefix: string;

  /** CloudFront / ALB アクセスログ保持日数 */
  accessLogRetentionDays: number;

  /** 行動ログ Raw データ保存用 S3 バケット名 */
  actionLogRawBucketName: string;

  /** 行動ログ Raw データ保存用 S3 プレフィックス */
  actionLogRawPrefix: string;

  /** 行動ログ Athena Partition Projection 開始年 */
  actionLogProjectionStartYear: number;

  /** 行動ログ Athena Partition Projection 終了年 */
  actionLogProjectionEndYear: number;

  /** 行動ログ Athena 中間成果物保存用 S3 バケット名 */
  actionLogIntermediateBucketName: string;

  /** 行動ログ Athena 中間成果物保存用 S3 プレフィックス */
  actionLogIntermediatePrefix: string;

  /** 行動ログ Delivery TSV 出力用 S3 バケット名 */
  actionLogDeliveryBucketName: string;

  /** 行動ログ Delivery TSV 取得用の顧客 AWS アカウント ID */
  actionLogDeliveryCustomerAccountId?: string;

  /** 行動ログ Delivery TSV 取得用 Cross-Account Role の ExternalId */
  actionLogDeliveryExternalId?: string;

  /** 行動ログ Events Delivery TSV 出力用 S3 プレフィックス */
  actionLogDeliveryEventsPrefix: string;

  /** 行動ログ Attributes Delivery TSV 出力用 S3 プレフィックス */
  actionLogDeliveryAttributesPrefix: string;

  /** 行動ログ Delivery TSV 保持日数 */
  actionLogDeliveryRetentionDays: number;

  /** 管理画面静的サイト用 S3 バケット名 */
  adminSiteBucketName: string;

  /** CloudTrail ログ保存用 S3 バケット名 */
  cloudTrailBucketName: string;

  /** Amazon Inspector 有効化 */
  enableInspector: boolean;

  /** AWS X-Ray 有効化 */
  enableXray: boolean;

  /** イベント処理基盤の有効化 */
  enableEventProcessing: boolean;

  /** EventBridge カスタムバス名（空の場合は自動生成） */
  eventBusName?: string;

  /** 管理画面アップロード動画の入力プレフィックス */
  videoUploadPrefix: string;

  /** CloudFront 配信用公開アセットプレフィックス */
  mediaOutputPrefix: string;

  /** MediaConvert エンドポイント（未確定時はプレースホルダー） */
  mediaConvertEndpoint: string;

  /** MediaConvert 実行ロール ARN（未確定時はプレースホルダー） */
  mediaConvertRoleArn: string;

  /** Push 配信アプリケーション ID（未確定時はプレースホルダー） */
  pushApplicationId: string;

  /** Push 認証情報シークレット ARN（未確定時はプレースホルダー） */
  pushCredentialsSecretArn: string;

  /** イベント処理 Lambda のタイムアウト秒数 */
  eventProcessorTimeoutSec: number;

  /** イベント処理 Lambda のメモリサイズ（MiB） */
  eventProcessorMemoryMiB: number;

  /** メインキュー可視性タイムアウト秒数 */
  eventQueueVisibilityTimeoutSec: number;

  /** メイン/DLQ 保持期間（日） */
  eventQueueRetentionDays: number;

  /** DLQ への移送までの最大受信回数 */
  eventDlqMaxReceiveCount: number;

  /** Edge スタックのデプロイリージョン（CloudFront/WAF/ACM 用） */
  edgeRegion: string;

  /** CloudFront 配信用ドメイン名（未確定時はプレースホルダー） */
  edgeDomainName: string;

  /** Route 53 ホストゾーン名（未確定時はプレースホルダー） */
  hostedZoneName: string;

  /** Route 53 ホストゾーン ID（未確定時はプレースホルダー） */
  hostedZoneId: string;

  /** Edge 用 ACM 証明書 ARN（us-east-1、未確定時はプレースホルダー） */
  edgeCertificateArn: string;

  /** CloudFront から ALB へ付与する Origin 検証ヘッダー名 */
  cloudFrontOriginVerifyHeaderName: string;

  /** CloudFront から ALB へ付与する Origin 検証ヘッダー値 */
  cloudFrontOriginVerifyHeaderValue: string;

  /** CloudFront Origin-Facing のマネージドプレフィックスリスト ID */
  cloudFrontOriginPrefixListId: string;

  /** 管理画面静的サイトのデフォルトルートオブジェクト */
  adminSiteDefaultRootObject: string;

  /** 行動ログ Athena データベース名 */
  actionLogAthenaDatabaseName: string;

  /** 行動ログ Raw 外部テーブル名 */
  actionLogRawTableName: string;
}

/** 未確定パラメータのプレースホルダープレフィックス */
export const PLACEHOLDER_PREFIX = 'PLACEHOLDER_';

/**
 * 設定値がプレースホルダーかどうかを判定するヘルパー
 */
export function isPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * リソース名を生成するヘルパー関数
 * @param envName 環境名（dev / stg / prod）
 * @param resource リソース識別子
 * @returns `${AppName}-${envName}-${resource}` 形式の文字列
 */
export function buildResourceName(envName: string, resource: string): string {
  return `${AppName}-${envName}-${resource}`;
}
