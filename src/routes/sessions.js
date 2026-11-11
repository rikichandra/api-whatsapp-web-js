const { Router } = require('express');
const sessionManager = require('../services/sessionManager');
const { success } = require('../lib/response');
const { asyncHandler } = require('../middleware/errorHandler');
const { httpError } = require('../errors');
const { serializeContact, serializeGroup } = require('../lib/serialize');

const router = Router();

router.get('/', (_req, res) => {
  success(res, { sessions: sessionManager.list() });
});

router.get('/:id', (req, res) => {
  const session = sessionManager.get(req.params.id);
  success(res, {
    id: req.params.id,
    status: session.status,
  });
});

router.post('/:id/start', asyncHandler(async (req, res) => {
  await sessionManager.boot(req.params.id);
  const session = await sessionManager.waitForBoot(req.params.id);
  success(res, {
    id: req.params.id,
    status: session.status,
    qr: session.qrDataUri,
  });
}));

router.post('/:id/stop', asyncHandler(async (req, res) => {
  await sessionManager.stop(req.params.id);
  success(res, { id: req.params.id, stopped: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await sessionManager.destroy(req.params.id);
  success(res, { id: req.params.id, destroyed: true });
}));

router.get('/:id/qr', asyncHandler(async (req, res) => {
  if (!sessionManager.has(req.params.id)) {
    await sessionManager.boot(req.params.id);
  }

  const session = await sessionManager.waitForBoot(req.params.id, 20000);
  success(res, {
    id: req.params.id,
    status: session.status,
    qr: session.qrDataUri,
  });
}));

router.get('/:id/chats', asyncHandler(async (req) => {
  sessionManager.requireReady(req.params.id);
  throw httpError(
    'Chat listing is temporarily disabled because whatsapp-web.js getChats is unstable on the current WhatsApp Web build.',
    501,
    'chat_list_disabled',
  );
}));

router.get('/:id/contacts', asyncHandler(async (req, res) => {
  const session = sessionManager.requireReady(req.params.id);
  const contacts = await session.client.getContacts();

  success(res, {
    id: req.params.id,
    contacts: contacts
      .map(serializeContact)
      .filter(Boolean),
  });
}));

/**
 * getChats() is unstable across WhatsApp Web builds (see /:id/chats above), so groups are
 * discovered via getContacts() instead: group chats also show up there as contacts whose id
 * ends in `@g.us`, including Community sub-groups that were never opened in this session.
 * Each id is then resolved through getChatById() for full metadata, falling back to the bare
 * contact (id + name only) when that resolution fails.
 *
 * Note: whatsapp-web.js does not reliably expose which Community a group belongs to (its
 * groupMetadata has no working parent-link field, and is itself inconsistently populated
 * across calls) - so that mapping, where needed, is maintained manually on the Laravel side.
 */
async function fetchGroups(session) {
  const contacts = await session.client.getContacts();

  const groupIds = contacts
    .map((contact) => contact.id?._serialized)
    .filter((id) => typeof id === 'string' && id.endsWith('@g.us'))
    .slice(0, 50);

  try {
    const groupResults = await Promise.allSettled(
      groupIds.map((groupId) => session.client.getChatById(groupId)),
    );

    const groups = groupResults
      .map((result, index) => {
        try {
          if (result.status === 'fulfilled' && result.value) {
            return serializeGroup(result.value);
          }
        } catch {
          // fall through to contact fallback below
        }

        const fallbackId = groupIds[index];
        const fallbackContact = contacts.find(
          (contact) => contact.id?._serialized === fallbackId,
        );

        if (!fallbackId) {
          return null;
        }

        return {
          id: fallbackId,
          name: fallbackContact?.name
            ?? fallbackContact?.pushname
            ?? 'Unnamed Group',
          isAnnouncement: false,
          participants: 0,
        };
      })
      .filter(Boolean);

    return { groups, degraded: false };
  } catch {
    const groups = groupIds.map((id) => {
      const fallbackContact = contacts.find(
        (contact) => contact.id?._serialized === id,
      );

      return {
        id,
        name: fallbackContact?.name
          ?? fallbackContact?.pushname
          ?? 'Unnamed Group',
        isAnnouncement: false,
        participants: 0,
      };
    });

    return { groups, degraded: true };
  }
}

router.get('/:id/groups', asyncHandler(async (req, res) => {
  const session = sessionManager.requireReady(req.params.id);
  const { groups, degraded } = await fetchGroups(session);

  success(res, {
    id: req.params.id,
    groups,
    ...(degraded ? { degraded: true } : {}),
  });
}));

/**
 * Look up groups by exact display name (case-insensitive), the way
 * `chats.find(chat => chat.isGroup && chat.name === name)` would with getChats() -
 * except backed by the getContacts()-based discovery above, which also finds Community
 * sub-groups. Names aren't unique across Communities (e.g. multiple Communities can each
 * have a "General" group), so this returns every match rather than guessing one - the
 * caller disambiguates (e.g. Laravel's own group-id -> Community name mapping).
 */
router.get('/:id/groups/lookup', asyncHandler(async (req, res) => {
  const session = sessionManager.requireReady(req.params.id);
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';

  if (!name) {
    throw httpError('`name` query parameter is required', 422, 'validation_error');
  }

  const { groups, degraded } = await fetchGroups(session);
  const matches = groups.filter(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
  );

  if (matches.length === 0) {
    throw httpError(`No group found with name "${name}"`, 404, 'group_not_found');
  }

  success(res, {
    id: req.params.id,
    matches,
    ...(degraded ? { degraded: true } : {}),
  });
}));

module.exports = router;
