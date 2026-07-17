'use strict';

exports.handler = async (event) => {
  const records = event && Array.isArray(event.Records) ? event.Records : [];

  for (const record of records) {
    if (!record || typeof record.body !== 'string') {
      throw new Error('SQS レコード形式が不正です');
    }

    let payload;
    try {
      payload = JSON.parse(record.body);
    } catch (error) {
      throw new Error(`JSON 解析に失敗しました: ${error.message}`);
    }

    const source = payload.source;
    const detail = payload.detail || {};
    const operation = payload.operation || detail.operation;

    if (operation === 'process-media-upload') {
      console.log('メディア処理プレースホルダー', {
        mediaId: payload.mediaId || detail.mediaId,
        resourceType: payload.resourceType || detail.resourceType,
        uploadKey: payload.uploadKey || detail.uploadKey,
        publicKey: payload.publicKey || detail.publicKey,
        dbSecretArn: process.env.DB_SECRET_ARN,
        endpoint: process.env.MEDIACONVERT_ENDPOINT,
        roleArn: process.env.MEDIACONVERT_ROLE_ARN,
        eventId: payload.id || 'direct-sqs-message',
      });
      continue;
    }

    if (source === 'mti.app' && operation === 'send-push') {
      console.log('Push 配信プレースホルダー', {
        applicationId: process.env.PUSH_APPLICATION_ID,
        secretArn: process.env.PUSH_CREDENTIALS_SECRET_ARN,
        eventId: payload.id,
      });
      continue;
    }

    if (source === 'aws.mediaconvert') {
      console.log('MediaConvert ステータスコールバック', {
        detailType: payload['detail-type'],
        status: detail.status,
        jobId: detail.jobId,
      });
      continue;
    }

    console.log('未対応イベントを受信', {
      source: source || 'unknown',
      detailType: payload['detail-type'] || 'unknown',
      eventId: payload.id || 'unknown',
    });
  }
};
