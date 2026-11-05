import type { FastifyReply } from 'fastify';

export const sendInvalidInput = (reply: FastifyReply, message: string): FastifyReply =>
  reply.status(400).send({ error: 'INVALID_INPUT', message });
