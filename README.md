# MTI ビデオシステム — CDK インフラストラクチャ

## 概要

AWS CDK (TypeScript v2) を使用して MTI ビデオ配信・管理システムのインフラをデプロイします。
東京リージョン (ap-northeast-1) への高可用デュアル AZ 構成です。

## アーキテクチャ概要

### スタック構成と依存関係

```
NetworkStack  ←─────────────────────────────── 全スタックの基盤
    │
    ├── DataStack        Aurora MySQL / S3 / ECR
    │
    ├── SecurityStack    KMS / IAM クロスアカウントロール（WAF/ACM は Phase 4）
    │
    ├── ComputeStack     ALB / ECS Fargate / Auto Scaling
    │   （DataStack + SecurityStack にも依存）
    │
    └── EventProcessingStack  EventBridge / SQS / Lambda / CloudWatch Alarm
        （NetworkStack + DataStack + ComputeStack に依存）
```

### 各スタックのリソース

| スタック | 主なリソース |
|---------|------------|
| NetworkStack | VPC (10.0.0.0/16)、6サブネット (Public/Private/DB × 2AZ)、IGW、NAT GW、VPC Endpoints |
| DataStack | Aurora MySQL 3.04 (T4G.Large)、S3 (動画/Glacier 3年移行)、ECR |
| SecurityStack | KMS CMK、クロスアカウント IAM Role（WAF/ACM は Phase 4 で追加） |
| ComputeStack | ALB (Public)、ECS Fargate (Private)、Application Auto Scaling |
| EventProcessingStack | EventBridge カスタムバス、BusinessEvent ルール、SQS メイン/DLQ、EventProcessor Lambda、失敗監視アラーム |

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
| VPC Endpoints | 無効 | 有効 | 有効 |
| Aurora Multi-AZ | なし | あり | あり |
| Fargate CPU/Memory | 256/512 MiB | 512/1024 MiB | 512/1024 MiB |
| ECS 最小/最大タスク | 1/2 | 2/3 | 2/3 |
| EventProcessing 有効化 | 有効 | 有効 | 有効 |
| EventProcessor Timeout / Memory | 30秒 / 256MiB | 60秒 / 512MiB | 60秒 / 512MiB |
| EventQueue Visibility / Retention / DLQ回数 | 120秒 / 4日 / 3回 | 180秒 / 14日 / 5回 | 180秒 / 14日 / 5回 |

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
| ドメイン名 | `domainName` | Route 53 ホストゾーン作成後に設定 |
| ACM 証明書 ARN | `certificateArn` | Certificate Manager で発行後に設定 |
| WAF JPKI IP Set ARN | `wafJpkiIpSetArn` | WAF IP Set 作成後に設定 (Phase 4) |
| 外部 Cognito アカウント ID | `externalCognitoAccountId` | 外部チームから連携後に設定 |
| MediaConvert Endpoint | `mediaConvertEndpoint` | MediaConvert エンドポイント確定後に設定 |
| MediaConvert Role ARN | `mediaConvertRoleArn` | MediaConvert 実行ロール作成後に設定 |
| Push Application ID | `pushApplicationId` | Push 配信基盤のアプリ ID 確定後に設定 |
| Push Credentials Secret ARN | `pushCredentialsSecretArn` | Secrets Manager シークレット作成後に設定 |

### 動画アップロード/出力プレフィックス
- 入力: `uploads/`
- 出力: `processed/`

管理画面からの動画アップロードは `uploads/` 配下に保存し、MediaConvert の出力は `processed/` 配下へ分離する前提です。

## 注意事項

### 削除保護
Aurora MySQL、S3 バケット、ECR リポジトリ、KMS キーには `RemovalPolicy.RETAIN` が設定されています。
`cdk destroy` を実行しても**データリソースは削除されません**。手動での削除が必要です。

### 本番環境の終了保護
`prod` 環境のスタックには `terminationProtection: true` が設定されています。
誤って `cdk destroy` を実行してもスタックは削除されません。
