# MTI-AsahimyappSystem — CDK インフラストラクチャ

## 概要

AWS CDK (TypeScript v2) を使用して MTI-AsahimyappSystem のインフラをデプロイします。
東京リージョン (ap-northeast-1) の高可用デュアル AZ 構成と、
Edge リージョン (us-east-1) の CloudFront/WAF 構成を併用します。

## アーキテクチャ概要

### スタック構成と依存関係

```text
NetworkStack  ←─────────────────────────────── 全スタックの基盤
    │
    ├── DataStack        Aurora MySQL / S3 / ECR
    │
    ├── SecurityStack    KMS / IAM クロスアカウントロール / CloudTrail / GuardDuty / Inspector
    │
    ├── ComputeStack     ALB / ECS Fargate / Auto Scaling
    │   （DataStack + SecurityStack にも依存）
    │
    └── EventProcessingStack  EventBridge / SQS / Lambda / CloudWatch Alarm
        （NetworkStack + DataStack + ComputeStack に依存）

EdgeStack (us-east-1)  CloudFront / CloudFront WAF / 管理画面静的サイト S3 / Route 53・ACM 連携
    （ComputeStack に依存、ALB オリジン設定を参照）
```

### 各スタックのリソース

| スタック | 主なリソース |
| --- | --- |
| NetworkStack | VPC (10.0.0.0/16)、6サブネット (Public/Private/DB × 2AZ)、IGW、NAT GW、固定 NAT EIP、VPC Endpoints |
| DataStack | Aurora MySQL 3.04 (T4G.Large)、S3 (動画/Glacier 3年移行)、ECR、AWS Backup、Athena Workgroup |
| SecurityStack | KMS CMK、クロスアカウント IAM Role、CloudTrail、GuardDuty、SecurityHub、Inspector |
| ComputeStack | ALB (Public)、ECS Fargate (Private)、Application Auto Scaling、X-Ray Daemon Sidecar |
| EventProcessingStack | EventBridge カスタムバス、BusinessEvent ルール、SQS メイン/DLQ、EventProcessor Lambda、失敗監視アラーム |
| EdgeStack (us-east-1) | 管理画面静的サイト S3、CloudFront Distribution、WAFv2 (CLOUDFRONT)、Route 53 Alias、ACM 証明書連携 |

### Phase 5 イベント処理フロー（プレースホルダー実装）

1. 管理画面アップロード動画は S3 バケットの `uploads/` プレフィックスに保存  
2. S3 `Object Created` イベントを EventBridge 経由で SQS メインキューへ配送  
3. `mti.app` / `BusinessEvent` も EventBridge カスタムバス経由で同キューへ集約  
4. EventProcessor Lambda が SQS をポーリングし、`submit-media-job` / `send-push` / S3アップロード起点イベントを分岐処理（実行はプレースホルダー）  
5. `aws.mediaconvert` ステータスイベントを既定バスから同メインキューへ集約  
6. リトライ超過メッセージは DLQ へ退避し、CloudWatch Alarm で検知

## 前提条件

- Node.js 18 以上
- AWS CLI 設定済み (`aws configure`)
- CDK Bootstrap 実施済み (`cdk bootstrap aws://ACCOUNT_ID/ap-northeast-1`)

```bash
npm install
```

## 環境変数

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `CDK_DEPLOY_ACCOUNT` | デプロイ先 AWS アカウント ID | 推奨（未設定時は `CDK_DEFAULT_ACCOUNT` を使用） |

```bash
export CDK_DEPLOY_ACCOUNT=123456789012
```

## 環境別設定 (lib/config/environments.ts)

| パラメータ | dev | stg | prod |
|-----------|-----|-----|------|
| NAT 方式 | Regional | Regional | Regional |
| 固定 NAT EIP | 任意 | 有効 | 有効 |
| VPC Endpoints | 無効 | 有効 | 有効 |
| Aurora Multi-AZ | なし | あり | あり |
| Fargate CPU/Memory | 256/512 MiB | 512/1024 MiB | 512/1024 MiB |
| ECS 最小/最大タスク | 1/2 | 2/3 | 2/3 |
| Backup 有効化 | 無効 | 有効 | 有効 |
| Athena 有効化 | 無効 | 有効 | 有効 |
| Inspector 有効化 | 無効 | 有効 | 有効 |
| X-Ray 有効化 | 有効 | 有効 | 有効 |
| CloudFront WAF | 無効 | 有効 | 有効 |
| EventProcessing 有効化 | 有効 | 有効 | 有効 |
| EventProcessor Timeout / Memory | 30秒 / 256MiB | 60秒 / 512MiB | 60秒 / 512MiB |
| EventQueue Visibility / Retention / DLQ回数 | 120秒 / 4日 / 3回 | 180秒 / 14日 / 5回 | 180秒 / 14日 / 5回 |
| Edge リージョン | us-east-1 | us-east-1 | us-east-1 |

## よく使うコマンド

### テンプレート生成 (Synth)

```bash
# 開発環境
npx cdk synth -c env=dev

# ステージング環境
npx cdk synth -c env=stg

# 本番環境
npx cdk synth -c env=prod
```

### スタック一覧確認

```bash
npx cdk list -c env=dev
```

### デプロイ（推奨順序）

```bash
# 1. ネットワーク基盤を先にデプロイ
npx cdk deploy MTI-dev-NetworkStack -c env=dev

# 2. データ基盤とセキュリティ基盤をデプロイ（順序不問）
npx cdk deploy MTI-dev-DataStack -c env=dev
npx cdk deploy MTI-dev-SecurityStack -c env=dev

# 3. 計算基盤を最後にデプロイ
npx cdk deploy MTI-dev-ComputeStack -c env=dev
npx cdk deploy MTI-dev-EventProcessingStack -c env=dev

# 4. Edge 基盤（CloudFront/WAF）をデプロイ
npx cdk deploy MTI-dev-EdgeStack -c env=dev

# または全スタックを一括デプロイ（CDK が依存順序を自動解決）
npx cdk deploy --all -c env=dev
```

### 差分確認 (Diff)

```bash
npx cdk diff --all -c env=dev
```

### TypeScript コンパイルチェック

```bash
npx tsc --noEmit
```

## 占位パラメータ (Placeholder) の確定手順

以下の項目は現在プレースホルダー値が設定されています。
確定次第 `lib/config/environments.ts` の該当フィールドを更新してください。

| パラメータ | フィールド名 | 確定時の対応 |
|-----------|-------------|-------------|
| Edge ドメイン名 | `edgeDomainName` | CloudFront 配信用ドメイン確定後に設定 |
| Edge ACM 証明書 ARN | `edgeCertificateArn` | us-east-1 で証明書発行後に設定 |
| Route 53 ホストゾーン名 | `hostedZoneName` | 既存ホストゾーン確定後に設定 |
| Route 53 ホストゾーン ID | `hostedZoneId` | 既存ホストゾーン確定後に設定 |
| CloudFront ALB オリジン | `albOriginDomainName` | ALB DNS 名確定後に設定 |
| 外部 Cognito アカウント ID | `externalCognitoAccountId` | 外部チームから連携後に設定 |
| MediaConvert Endpoint | `mediaConvertEndpoint` | MediaConvert エンドポイント確定後に設定 |
| MediaConvert Role ARN | `mediaConvertRoleArn` | MediaConvert 実行ロール作成後に設定 |
| Push Application ID | `pushApplicationId` | Push 配信基盤のアプリ ID 確定後に設定 |
| Push Credentials Secret ARN | `pushCredentialsSecretArn` | Secrets Manager シークレット作成後に設定 |

### 動画アップロード/出力プレフィックス
- 入力: `uploads/`
- 出力: `processed/`

管理画面からの動画アップロードは `uploads/` 配下に保存し、MediaConvert の出力は `processed/` 配下へ分離する前提です。

### 入出力アクセス制御

- スマートフォンアプリ向け API、管理画面、管理 API は CloudFront 経由で公開します。
- CloudFront WAF は AWS Managed Rules による一般的な Web 攻撃対策を適用します。
- 管理画面と管理 API は外部 Cognito とアプリケーション権限でアクセス制御します。
- JPKI 認証サーバーと mypage サーバーは AWS 環境から外部へアクセスする連携先です。JPKI の OAuth 2.0 Client Credentials 認証はアプリケーション側で実行し、送信元 IP 制限は NAT Gateway の固定 EIP を連携先へ登録します。
- mypage サーバー連携は固定 NAT EIP を使用します。OAuth 2.0 サーバー認証は現時点では JPKI 連携にのみ適用します。

## 注意事項

### 削除保護
Aurora MySQL、S3 バケット、ECR リポジトリ、KMS キーには `RemovalPolicy.RETAIN` が設定されています。
`cdk destroy` を実行しても**データリソースは削除されません**。手動での削除が必要です。

### 本番環境の終了保護
`prod` 環境のスタックには `terminationProtection: true` が設定されています。
誤って `cdk destroy` を実行してもスタックは削除されません。
