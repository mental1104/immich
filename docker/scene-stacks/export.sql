-- 导出当前可见、在线的照片封面及既有特征；全程只读，不读取原片，按用户分组。
-- 每行一个JSON对象，供NAS目录服务流式导入；真实导出必须保存在仓库外的私有HDD目录。
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='120s';
SET LOCAL TIME ZONE 'UTC';
SELECT json_build_object(
 'id',a.id,'owner_id',a."ownerId",'taken',a."localDateTime",'stack_id',a."stackId",
 'revision',concat(a."updatedAt"::text,'/',e."updatedAt"::text,'/',encode(a.checksum,'hex')),
 'source_key',md5(concat(a."updatedAt"::text,e."updatedAt"::text,a."stackId"::text,a."localDateTime"::text,
     ss.embedding::text,p.path,e."fNumber"::text,e."exposureTime",encode(a.checksum,'hex'))),
 'embedding',ss.embedding::text,'shutter',e."exposureTime",'aperture',e."fNumber",
 'preview',p.path)
FROM asset a LEFT JOIN stack s ON s.id=a."stackId"
JOIN asset_exif e ON e."assetId"=a.id
LEFT JOIN smart_search ss ON ss."assetId"=a.id
LEFT JOIN LATERAL (
 SELECT f.path FROM asset_file f WHERE f."assetId"=a.id AND f.type IN ('preview','thumbnail')
 ORDER BY (f.type='preview') DESC,f."isEdited" DESC LIMIT 1
) p ON true
WHERE a.visibility='timeline' AND a."deletedAt" IS NULL AND NOT a."isOffline" AND a.type='IMAGE'
AND (s.id IS NULL OR s."primaryAssetId"=a.id)
AND e."fNumber">0 AND trim(e."exposureTime") NOT IN ('','0','0/1')
ORDER BY a."ownerId",a."localDateTime" DESC,a.id;
COMMIT;
