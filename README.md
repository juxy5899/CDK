# asahimyapp-infra

## 概要

asahimyapp-infra は AWS CDK (TypeScript v2) を使用して MTI-AsahimyappSystem のインフラをデプロイします。
東京リージョン (ap-northeast-1) の高可用デュアル AZ 構成と、
Edge リージョン (us-east-1) の CloudFront/WAF 構成を併用します。

## アーキテクチャ概要

### スタック構成と依存関係

```text
NetworkStack  ←─────────────────────────────── 全スタックの基盤
    │
    ├── SecurityStack    IAM クロスアカウントロール / CloudTrail / GuardDuty / Inspector
    │
    ├── DataStack        Aurora MySQL / S3 / ECR
    │   （SecurityStack にも依存）
    │
    ├── MediaProcessingStack  Media SQS / DLQ / EventBridge Rule / MediaEventProcessor Lambda
    │   （DataStack にも依存）
    │
    ├── ComputeStack     ALB / ECS Fargate / Auto Scaling
    │   （DataStack + MediaProcessingStack にも依存）

EdgeStack (us-east-1)  CloudFront / CloudFront WAF / 管理画面静的サイト S3 / Route 53・ACM 連携
    （ComputeStack に依存、ALB オリジン設定を参照）
```

### 各スタックのリソース

| スタック              | 主なリソース                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| NetworkStack          | VPC (10.0.0.0/16)、6サブネット (Public/Private/DB × 2AZ)、IGW、NAT GW、固定 NAT EIP、VPC Endpoints      |
| DataStack             | Aurora MySQL 3.04 (環境別インスタンスクラス)、media S3、ECR、AWS Backup、Athena Workgroup               |
| SecurityStack         | クロスアカウント IAM Role、CloudTrail、GuardDuty、SecurityHub、Inspector                                |
| ComputeStack          | ALB (Public)、ECS Fargate (Private)、Application Auto Scaling、X-Ray Daemon Sidecar                     |
| MediaProcessingStack  | Media SQS/DLQ、Media upload ルール、MediaConvert ステータスルール、MediaEventProcessor Lambda、処理監視 |
| EdgeStack (us-east-1) | 管理画面静的サイト S3、CloudFront Distribution、WAFv2 (CLOUDFRONT)、Route 53 Alias、ACM 証明書連携      |

### Phase 5 イベント処理フロー

1. 管理画面アップロード media は S3 バケットの `uploads/` プレフィックスに保存
2. Spring Boot はアップロード完了 API で S3 オブジェクトを確認し、Media SQS へ `process-media-upload` を送信
3. `aws.mediaconvert` ステータスイベントは既定バスから Media SQS へ配送
4. MediaEventProcessor Lambda は `MediaProcessingStack` に配置し、SQS 消費、VPC 接続、IAM 権限を定義
5. リトライ超過メッセージは Media DLQ へ退避し、CloudWatch Alarm で検知

## 前提条件

- Node.js 18 以上
- AWS CLI 設定済み (`aws configure`)
- CDK Bootstrap 実施済み (`cdk bootstrap aws://ACCOUNT_ID/ap-northeast-1`)

```bash
npm install
```

## 環境変数

| 変数名               | 説明                         | 必須                                            |
| -------------------- | ---------------------------- | ----------------------------------------------- |
| `CDK_DEPLOY_ACCOUNT` | デプロイ先 AWS アカウント ID | 推奨（未設定時は `CDK_DEFAULT_ACCOUNT` を使用） |

```bash
export CDK_DEPLOY_ACCOUNT=123456789012
```

## 環境別設定 (lib/config/environments.ts)

| パラメータ                                  | dev               | stg                | prod               |
| ------------------------------------------- | ----------------- | ------------------ | ------------------ |
| NAT 方式                                    | Regional          | Regional           | Regional           |
| 固定 NAT EIP                                | 任意              | 有効               | 有効               |
| S3 Gateway Endpoint                         | 有効              | 有効               | 有効               |
| Interface VPC Endpoints                     | 無効              | 有効               | 有効               |
| Aurora Multi-AZ                             | なし              | あり               | あり               |
| Fargate CPU/Memory                          | 256/512 MiB       | 512/1024 MiB       | 512/1024 MiB       |
| app-api ECS 最小/最大タスク                 | 1/2               | 2/3                | 2/3                |
| mgt-api ECS 最小/最大タスク                 | 1/1               | 2/3                | 2/3                |
| Backup 有効化                               | 無効              | 有効               | 有効               |
| Athena 有効化                               | 有効              | 有効               | 有効               |
| Inspector 有効化                            | 無効              | 有効               | 有効               |
| X-Ray 有効化                                | 有効              | 有効               | 有効               |
| CloudFront WAF                              | 無効              | 有効               | 有効               |
| EventBridge ルール有効化                    | 無効              | 無効               | 無効               |
| EventProcessor Timeout / Memory             | 30秒 / 256MiB     | 60秒 / 512MiB      | 60秒 / 512MiB      |
| EventQueue Visibility / Retention / DLQ回数 | 120秒 / 4日 / 3回 | 180秒 / 14日 / 5回 | 180秒 / 14日 / 5回 |
| Edge リージョン                             | us-east-1         | us-east-1          | us-east-1          |

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

# 2. セキュリティ基盤をデプロイ
npx cdk deploy MTI-dev-SecurityStack -c env=dev

# 3. データ基盤をデプロイ
npx cdk deploy MTI-dev-DataStack -c env=dev

# 4. Media 処理基盤、計算基盤をデプロイ
npx cdk deploy MTI-dev-MediaProcessingStack -c env=dev
npx cdk deploy MTI-dev-ComputeStack -c env=dev

# 5. Edge 基盤（CloudFront/WAF）をデプロイ（CloudFront 経由の動作確認時）
npx cdk deploy MTI-dev-EdgeStack -c env=dev

# または全スタックを一括デプロイ（CDK が依存順序を自動解決）
npx cdk deploy --all -c env=dev
```

### stg/prod Compute・Edge デプロイパラメータ

stg/prod の ComputeStack・EdgeStack をデプロイする場合は、以下の CDK context を指定します。

| context                   | 用途                                                         | dev の扱い               |
| ------------------------- | ------------------------------------------------------------ | ------------------------ |
| `appApiImageTag`          | app-api ECS Service が起動する ECR イメージタグ              | 未指定時は `latest`      |
| `mgtApiImageTag`          | mgt-api ECS Service が起動する ECR イメージタグ              | 未指定時は `latest`      |
| `originVerifyHeaderValue` | CloudFront から ALB へ付与する Origin 検証ヘッダー値         | プレースホルダー値を使用 |
| `strictComputeValidation` | stg/prod の Compute・Edge 入力値をデプロイ前に検証するフラグ | 指定不要                 |

```bash
npx cdk deploy MTI-stg-ComputeStack -c env=stg -c appApiImageTag=20260718-app-001 -c mgtApiImageTag=20260718-mgt-001 -c originVerifyHeaderValue=<origin-verify-value> -c strictComputeValidation=true
npx cdk deploy MTI-stg-EdgeStack -c env=stg -c appApiImageTag=20260718-app-001 -c mgtApiImageTag=20260718-mgt-001 -c originVerifyHeaderValue=<origin-verify-value> -c strictComputeValidation=true
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

| パラメータ                               | フィールド名                         | 確定時の対応                                           |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Edge ドメイン名                          | `edgeDomainName`                     | CloudFront 配信用ドメイン確定後に設定                  |
| Edge ACM 証明書 ARN                      | `edgeCertificateArn`                 | us-east-1 で証明書発行後に設定                         |
| Route 53 ホストゾーン名                  | `hostedZoneName`                     | 既存ホストゾーン確定後に設定                           |
| Route 53 ホストゾーン ID                 | `hostedZoneId`                       | 既存ホストゾーン確定後に設定                           |
| CloudFront Origin 検証ヘッダー値         | `originVerifyHeaderValue`            | Compute/Edge デプロイ時に CDK context で指定           |
| 行動ログ Delivery 顧客 AWS アカウント ID | `actionLogDeliveryCustomerAccountId` | 顧客 AWS アカウント確定後に設定                        |
| 行動ログ Delivery ExternalId             | `actionLogDeliveryExternalId`        | 顧客向け Cross-Account Role の ExternalId 確定後に設定 |
| Push Application ID                      | `pushApplicationId`                  | Push 配信基盤のアプリ ID 確定後に設定                  |
| Push Credentials Secret ARN              | `pushCredentialsSecretArn`           | Secrets Manager シークレット作成後に設定               |

### 動画アップロード/出力プレフィックス

- 入力: `uploads/`
- 出力: `public/`

管理画面からの動画アップロードは `uploads/` 配下に保存し、MediaConvert の出力は `public/` 配下へ分離する前提です。

### 入出力アクセス制御

- スマートフォンアプリ向け API、管理画面、管理 API は CloudFront 経由で公開します。
- スマートフォンアプリ向け API は `/app-api/*` から 8081、管理 API は `/mgt-api/*` から 8080 へ転送します。
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
