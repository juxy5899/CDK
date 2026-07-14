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

    if (source === 'mti.app' && detail.operation === 'submit-media-job') {
      console.log('MediaConvert ジョブ投入プレースホルダー', {
        endpoint: process.env.MEDIACONVERT_ENDPOINT,
        roleArn: process.env.MEDIACONVERT_ROLE_ARN,
        inputPrefix: process.env.VIDEO_UPLOAD_PREFIX,
        outputPrefix: process.env.MEDIA_OUTPUT_PREFIX,
        eventId: payload.id,
      });
      continue;
    }

    if (source === 'aws.s3' && payload['detail-type'] === 'Object Created') {
      console.log('S3 アップロード起点の MediaConvert ジョブ投入プレースホルダー', {
        bucket: detail.bucket && detail.bucket.name,
        objectKey: detail.object && detail.object.key,
        endpoint: process.env.MEDIACONVERT_ENDPOINT,
        roleArn: process.env.MEDIACONVERT_ROLE_ARN,
        inputPrefix: process.env.VIDEO_UPLOAD_PREFIX,
        outputPrefix: process.env.MEDIA_OUTPUT_PREFIX,
      });
      continue;
    }

    if (source === 'mti.app' && detail.operation === 'send-push') {
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
