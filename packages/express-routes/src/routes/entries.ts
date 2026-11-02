import type { ApplicationServices, entryListFilter, WhereFor } from '@borecount/core/application';
import { entryFilterFields, readWhereParameter } from '@borecount/http';
import type { EntriesPageResponse } from '@borecount/http/contracts';
import { toEntryResponse } from '@borecount/http/mappers';
import type { Application, Response } from 'express';
import { sendInvalidInput, withDomainErrorHandling } from '../errors/handlers';
import { parsePaginationQuery } from '../query/pagination';
import { requireContext } from '../request/context';
import type { RequestWithContext } from '../types';

type EntryRouteServices = Pick<ApplicationServices, 'transactions'>;

export const registerEntryRoutes = (app: Application, services: EntryRouteServices): void => {
  app.get('/v1/entries', async (req: RequestWithContext, res: Response) =>
    withDomainErrorHandling(res, async () => {
      const pagination = parsePaginationQuery(req.query);
      const where = readWhereParameter<WhereFor<typeof entryListFilter>>(
        req.originalUrl,
        entryFilterFields,
      );
      if (pagination === null || where === null) {
        sendInvalidInput(res, 'Invalid querystring');
        return;
      }
      const context = requireContext(req);
      const page = await services.transactions.listEntries({
        tenantId: context.tenantId,
        limit: pagination.limit,
        cursor: pagination.cursor,
        where,
      });
      const response: EntriesPageResponse = {
        data: page.data.map(toEntryResponse),
        next_cursor: page.nextCursor,
      };
      res.status(200).json(response);
    }),
  );
};
