import json
import os


def handler(event, context):
    records = event.get("Records", []) if isinstance(event, dict) else []

    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("body"), str):
            raise ValueError("SQS レコード形式が不正です")

        try:
            payload = json.loads(record["body"])
        except json.JSONDecodeError as error:
            raise ValueError(f"JSON 解析に失敗しました: {error}") from error

        source = payload.get("source")
        detail = payload.get("detail") if isinstance(payload.get("detail"), dict) else {}
        operation = payload.get("operation") or detail.get("operation")

        if operation == "process-media-upload":
            print(
                json.dumps(
                    {
                        "message": "メディア処理プレースホルダー",
                        "mediaId": payload.get("mediaId") or detail.get("mediaId"),
                        "resourceType": payload.get("resourceType") or detail.get("resourceType"),
                        "uploadKey": payload.get("uploadKey") or detail.get("uploadKey"),
                        "publicKey": payload.get("publicKey") or detail.get("publicKey"),
                        "dbSecretArn": os.environ.get("DB_SECRET_ARN"),
                        "endpoint": os.environ.get("MEDIACONVERT_ENDPOINT"),
                        "roleArn": os.environ.get("MEDIACONVERT_ROLE_ARN"),
                        "eventId": payload.get("id") or "direct-sqs-message",
                    },
                    ensure_ascii=False,
                )
            )
            continue

        if source == "mti.asahimyapp" and operation == "send-push":
            print(
                json.dumps(
                    {
                        "message": "Push 配信プレースホルダー",
                        "applicationId": os.environ.get("PUSH_APPLICATION_ID"),
                        "secretArn": os.environ.get("PUSH_CREDENTIALS_SECRET_ARN"),
                        "eventId": payload.get("id"),
                    },
                    ensure_ascii=False,
                )
            )
            continue

        if source == "aws.mediaconvert":
            print(
                json.dumps(
                    {
                        "message": "MediaConvert ステータスコールバック",
                        "detailType": payload.get("detail-type"),
                        "status": detail.get("status"),
                        "jobId": detail.get("jobId"),
                    },
                    ensure_ascii=False,
                )
            )
            continue

        print(
            json.dumps(
                {
                    "message": "未対応イベントを受信",
                    "source": source or "unknown",
                    "detailType": payload.get("detail-type") or "unknown",
                    "eventId": payload.get("id") or "unknown",
                },
                ensure_ascii=False,
            )
        )

    return {"ok": True}