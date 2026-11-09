import type { Asset } from '@borecount/core/application';
import type { AssetResponse } from '../contracts/assets';

export const toAssetResponse = (asset: Asset): AssetResponse => ({
  id: asset.id,
  tenant_id: asset.tenantId,
  code: asset.code,
  scale: asset.scale,
  created_at: asset.createdAt.toISOString(),
});
