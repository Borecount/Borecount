import type { AssetService } from '@borecount/core/application';
import {
  type AssetByIdParams,
  assetByIdParamsSchema,
  type CreateAssetRequest,
  createAssetBodySchema,
  parseAssetListQuery,
} from '@borecount/http/contracts';
import { toAssetResponse } from '@borecount/http/mappers';
import type { Application, Response } from 'express';
import { sendInvalidInput, withDomainErrorHandling } from '../errors/handlers';
import { assertAdmin, requireContext } from '../request/context';
import { validate } from '../request/validation';
import type { RequestWithContext } from '../types';

export const registerAssetRoutes = (app: Application, assets: AssetService): void => {
  app.post('/v1/assets', async (req: RequestWithContext, res: Response) =>
    withDomainErrorHandling(res, async () => {
      const body = validate<CreateAssetRequest>(createAssetBodySchema, req.body);
      if (body === null) {
        sendInvalidInput(res, 'Invalid request body');
        return;
      }
      const context = requireContext(req);
      assertAdmin(context);
      const { code, scale } = body;
      const asset = await assets.create({ tenantId: context.tenantId, code, scale });
      res.status(201).json(toAssetResponse(asset));
    }),
  );

  app.get('/v1/assets/:id', async (req: RequestWithContext, res: Response) =>
    withDomainErrorHandling(res, async () => {
      const params = validate<AssetByIdParams>(assetByIdParamsSchema, req.params);
      if (params === null) {
        sendInvalidInput(res, 'Invalid path parameter');
        return;
      }
      const { tenantId } = requireContext(req);
      const asset = await assets.getById(tenantId, params.id);
      res.status(200).json(toAssetResponse(asset));
    }),
  );

  app.get('/v1/assets', async (req: RequestWithContext, res: Response) =>
    withDomainErrorHandling(res, async () => {
      const query = parseAssetListQuery(req.originalUrl);
      if (query === null) {
        sendInvalidInput(res, 'Invalid querystring');
        return;
      }
      const { tenantId } = requireContext(req);
      const page = await assets.list({ tenantId, ...query });
      res.status(200).json({
        data: page.data.map(toAssetResponse),
        next_cursor: page.nextCursor,
      });
    }),
  );
};
