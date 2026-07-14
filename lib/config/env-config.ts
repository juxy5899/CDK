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

  /** VPC Interface Endpoint の有効化（dev:false でコスト削減） */
  vpcEndpointsEnabled: boolean;

  /** Aurora インスタンスクラス文字列（例: 'db.t4g.large'） */
  dbInstanceClass: string;

  /** Aurora Multi-AZ の有効化 */
  auroraMultiAz: boolean;

  /** Fargate タスク CPU（vCPU x 1024） */
  taskCpu: 256 | 512 | 1024 | 2048 | 4096;

  /** Fargate タスクメモリ（MiB） */
  taskMemoryMiB: 512 | 1024 | 2048 | 3072 | 4096 | 8192 | 16384;

  /** ECS 最小タスク数 */
  minTaskCount: number;

  /** ECS 最大タスク数 */
  maxTaskCount: number;

  /** ドメイン名（未確定: 'PLACEHOLDER_DOMAIN_NAME'） */
  domainName: string;

  /** ACM 証明書 ARN（未確定） */
  certificateArn: string;

  /** 外部 Cognito AWS アカウント ID（未確定） */
  externalCognitoAccountId: string;

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

  /** MediaConvert 出力先プレフィックス */
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

  /** CloudFront の ALB オリジンドメイン名（未確定時はプレースホルダー） */
  albOriginDomainName: string;

  /** CloudFront Origin-Facing のマネージドプレフィックスリスト ID */
  cloudFrontOriginPrefixListId: string;

  /** 管理画面静的サイトのデフォルトルートオブジェクト */
  adminSiteDefaultRootObject: string;
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
