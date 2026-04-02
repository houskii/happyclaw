import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getHostIntegrationStatuses,
  getMcpHostSyncSnapshot,
  getSkillsHostSyncSnapshot,
  syncHostIntegrationsForUser,
} from '../host-integrations.js';
import { saveSystemSettings } from '../runtime-config.js';
import { logger } from '../logger.js';

const hostIntegrationsRoutes = new Hono<{ Variables: Variables }>();

hostIntegrationsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skillsSync = getSkillsHostSyncSnapshot(authUser.id);
  const mcpSync = getMcpHostSyncSnapshot(authUser.id);

  return c.json({
    sources: getHostIntegrationStatuses(),
    skills: {
      lastSyncAt: skillsSync.lastSyncAt,
      syncedCount: Object.keys(skillsSync.owners).length,
    },
    mcp: {
      lastSyncAt: mcpSync.lastSyncAt,
      syncedCount: Object.keys(mcpSync.owners).length,
    },
  });
});

hostIntegrationsRoutes.put('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can update host integration sources' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || !Array.isArray(body.sources)) {
    return c.json({ error: 'sources must be an array' }, 400);
  }

  try {
    const saved = saveSystemSettings({
      hostIntegrationSources: body.sources,
    });
    return c.json({ sources: getHostIntegrationStatuses(saved.hostIntegrationSources) });
  } catch (err) {
    logger.warn({ err }, 'Invalid host integration sources payload');
    return c.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Invalid host integration sources payload',
      },
      400,
    );
  }
});

hostIntegrationsRoutes.post('/sync', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host integrations' }, 403);
  }

  const result = syncHostIntegrationsForUser(authUser.id);
  return c.json(result);
});

export default hostIntegrationsRoutes;
