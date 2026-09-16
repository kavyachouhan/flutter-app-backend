import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate, validated } from '../../middleware/validate.js';
import { idParams } from '../../lib/validators.js';
import * as membersService from './members.service.js';
import { addMemberBody, updateMemberBody } from './members.schemas.js';

export const membersRouter: Router = Router();

membersRouter.get('/', requirePermission('members:read'), async (_req, res) => {
  res.json({ data: await membersService.listMembers() });
});

const add = { body: addMemberBody };
membersRouter.post('/', requirePermission('members:manage'), validate(add), async (req, res) => {
  const { body } = validated<typeof add>(req);
  res.status(201).json({ data: await membersService.addMember(body) });
});

const update = { params: idParams, body: updateMemberBody };
membersRouter.patch(
  '/:id',
  requirePermission('members:manage'),
  validate(update),
  async (req, res) => {
    const { params, body } = validated<typeof update>(req);
    res.json({ data: await membersService.updateMember(params.id, body) });
  },
);

const byId = { params: idParams };
membersRouter.delete(
  '/:id',
  requirePermission('members:manage'),
  validate(byId),
  async (req, res) => {
    const { params } = validated<typeof byId>(req);
    await membersService.removeMember(params.id);
    res.status(204).end();
  },
);
