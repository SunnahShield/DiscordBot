const {
  AuditLogEvent,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const {
  getInviteTrackerState,
  updateInviteTrackerState,
} = require('./invite-tracker-store');

const ATTRIBUTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DELETED_INVITE_RETENTION_MS = 5 * 60 * 1000;
const AUDIT_LOG_WINDOW_MS = 20 * 1000;
const MEMBER_REMOVE_WAIT_MS = 1_500;
const JOIN_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000];

const COLORS = {
  success: 0x57f287,
  info: 0x5865f2,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x99aab5,
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function truncate(value, length = 1_000) {
  const text = String(value ?? 'Unknown');
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text;
}

function userLabel(user) {
  if (!user) return 'Unknown user';
  return user.tag ?? user.globalName ?? user.username ?? `Unknown user (${user.id ?? 'unknown ID'})`;
}

function userRecord(user) {
  if (!user?.id) return null;
  return {
    id: user.id,
    label: userLabel(user),
  };
}

function channelRecord(channel) {
  if (!channel?.id) return null;
  return {
    id: channel.id,
    label: channel.name ? `#${channel.name}` : `Channel ${channel.id}`,
  };
}

function mentionUsers(users) {
  return [...new Set(users.filter(Boolean).map((user) => user.id ?? user))]
    .map((id) => `<@${id}>`)
    .join(' ');
}

function mentionChannels(channels) {
  return [...new Set(channels.filter(Boolean).map((channel) => channel.id ?? channel))]
    .map((id) => `<#${id}>`)
    .join(' ');
}

function normalizeInvite(invite) {
  const inviter = userRecord(invite?.inviter);
  const channel = channelRecord(invite?.channel);
  const expiresTimestamp = invite?.expiresTimestamp
    ?? (invite?.expiresAt ? new Date(invite.expiresAt).getTime() : null);

  return {
    code: invite?.code ?? 'unknown',
    uses: Number(invite?.uses ?? 0),
    maxUses: Number(invite?.maxUses ?? 0),
    maxAge: Number(invite?.maxAge ?? 0),
    temporary: Boolean(invite?.temporary),
    inviter,
    channel,
    createdAt: invite?.createdTimestamp ?? (invite?.createdAt ? new Date(invite.createdAt).getTime() : null),
    expiresAt: Number.isFinite(expiresTimestamp) ? expiresTimestamp : null,
  };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    capturedAt: Number(snapshot.capturedAt) || Date.now(),
    invites: snapshot.invites && typeof snapshot.invites === 'object' ? snapshot.invites : {},
    vanityUses: Number.isFinite(snapshot.vanityUses) ? snapshot.vanityUses : null,
    vanityCode: snapshot.vanityCode ?? null,
  };
}

function makeEmbed(title, color, fields, description) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp();

  if (description) embed.setDescription(truncate(description, 4_000));
  const usableFields = fields
    .filter((field) => field?.name && field.value != null)
    .slice(0, 25)
    .map((field) => ({
      name: truncate(field.name, 256),
      value: truncate(field.value, 1_024),
      inline: Boolean(field.inline),
    }));
  if (usableFields.length) embed.addFields(usableFields);
  return embed;
}

function inviteFields(invite) {
  const fields = [
    { name: 'Invite code', value: `\`${invite.code}\``, inline: true },
    { name: 'Uses', value: `${invite.uses}${invite.maxUses ? ` / ${invite.maxUses}` : ' / unlimited'}`, inline: true },
  ];
  if (invite.inviter) fields.push({ name: 'Created by', value: `${invite.inviter.label} (${invite.inviter.id})`, inline: true });
  if (invite.channel) fields.push({ name: 'Channel', value: `${invite.channel.label} (${invite.channel.id})`, inline: true });
  if (invite.temporary) fields.push({ name: 'Temporary membership', value: 'Yes', inline: true });
  return fields;
}

function joinAttributionFields(attribution) {
  if (!attribution) return [{ name: 'Join source', value: 'Not recorded', inline: false }];

  if (attribution.kind === 'invite') {
    const fields = [
      { name: 'Join source', value: `Invite \`${attribution.code}\``, inline: true },
      { name: 'Uses at join', value: `${attribution.uses}${attribution.maxUses ? ` / ${attribution.maxUses}` : ' / unlimited'}`, inline: true },
    ];
    if (attribution.inviter) {
      fields.push({ name: 'Invited by', value: `${attribution.inviter.label} (${attribution.inviter.id})`, inline: false });
    }
    if (attribution.channel) {
      fields.push({ name: 'Invite channel', value: `${attribution.channel.label} (${attribution.channel.id})`, inline: false });
    }
    if (attribution.certainty === 'possible') {
      fields.push({
        name: 'Attribution confidence',
        value: 'Possible — the one-use invite disappeared at the same time as the join, so Discord cannot prove the code was consumed rather than deleted.',
        inline: false,
      });
    }
    return fields;
  }

  const messages = {
    vanity: `Server vanity URL${attribution.code ? ` \`${attribution.code}\`` : ''}`,
    platform: 'Discord non-invite join flow or a join source Discord does not expose to bots',
    ambiguous: 'More than one invite counter changed before Discord linked the join event; no single code can be assigned accurately',
    unavailable: 'Invite usage could not be read (the bot needs Manage Server)',
    warming: 'The bot was still establishing its current invite baseline',
  };
  return [{ name: 'Join source', value: messages[attribution.kind] ?? attribution.detail ?? 'Unknown', inline: false }];
}

function pruneAttributions(attributions, now) {
  for (const [memberId, attribution] of Object.entries(attributions)) {
    if (!attribution?.joinedAt || now - new Date(attribution.joinedAt).getTime() > ATTRIBUTION_RETENTION_MS) {
      delete attributions[memberId];
    }
  }
}

/**
 * A per-guild invite attribution tracker.
 *
 * Discord does not include an invite code in GUILD_MEMBER_ADD. The best an app
 * can do is compare the server's invite counters before and after that event;
 * this class serializes those comparisons, retries for eventual consistency,
 * and reports ambiguity instead of assigning a misleading inviter.
 */
function createInviteTracker({
  getConfig,
  setConfig,
  clearConfig,
  send,
  logger = console,
}) {
  const caches = new Map();
  const operations = new Map();
  const recentBans = new Map();
  const removalReports = new Map();

  function queue(guildId, task) {
    const previous = operations.get(guildId) ?? Promise.resolve();
    const next = previous.then(task, task);
    operations.set(guildId, next);
    next.finally(() => {
      if (operations.get(guildId) === next) operations.delete(guildId);
    }).catch(() => null);
    return next;
  }

  function cacheFor(guildId) {
    return caches.get(guildId) ?? { warmed: false, snapshot: null, deletedInvites: {} };
  }

  async function persistSnapshot(guildId, snapshot) {
    await updateInviteTrackerState(guildId, (state) => {
      state.lastSnapshot = normalizeSnapshot(snapshot);
    });
  }

  async function persistAttribution(guildId, memberId, attribution) {
    await updateInviteTrackerState(guildId, (state) => {
      pruneAttributions(state.attributions, Date.now());
      state.attributions[memberId] = {
        ...attribution,
        joinedAt: new Date().toISOString(),
      };
    });
  }

  async function takeAttribution(guildId, memberId) {
    return updateInviteTrackerState(guildId, (state) => {
      pruneAttributions(state.attributions, Date.now());
      const attribution = state.attributions[memberId] ?? null;
      delete state.attributions[memberId];
      return attribution;
    });
  }

  async function fetchSnapshot(guild) {
    const invites = await guild.invites.fetch().catch((error) => {
      logger.error?.(`Invite tracker could not fetch invites for ${guild.id}`, error);
      return null;
    });
    if (!invites) return null;

    const vanity = await guild.fetchVanityData().catch(() => null);
    const normalizedInvites = {};
    for (const invite of invites.values()) {
      const normalized = normalizeInvite(invite);
      normalizedInvites[normalized.code] = normalized;
    }

    return {
      capturedAt: Date.now(),
      invites: normalizedInvites,
      vanityUses: Number.isFinite(vanity?.uses) ? vanity.uses : null,
      vanityCode: vanity?.code ?? null,
    };
  }

  async function warmGuild(guild) {
    return queue(guild.id, async () => {
      const snapshot = await fetchSnapshot(guild);
      const previous = cacheFor(guild.id);
      if (!snapshot) {
        if (!caches.has(guild.id)) {
          caches.set(guild.id, { warmed: false, snapshot: null, deletedInvites: {} });
        }
        return { ok: false, retainedBaseline: previous.warmed };
      }

      const nextCache = {
        warmed: true,
        snapshot,
        deletedInvites: previous.deletedInvites ?? {},
      };
      caches.set(guild.id, nextCache);
      await persistSnapshot(guild.id, snapshot).catch((error) => logger.error?.('Could not persist invite baseline', error));
      return { ok: true, inviteCount: Object.keys(snapshot.invites).length, vanityAvailable: snapshot.vanityUses != null };
    });
  }

  async function emit(guild, title, {
    color = COLORS.info,
    users = [],
    channels = [],
    fields = [],
    description,
  } = {}) {
    const config = await getConfig(guild.id);
    if (!config?.channelId) return false;

    const content = [mentionUsers(users), mentionChannels(channels)].filter(Boolean).join(' ');
    try {
      await send(guild, config.channelId, {
        content: content || undefined,
        embeds: [makeEmbed(title, color, fields, description)],
        // Mentions remain clickable but do not ping moderators or former members.
        allowedMentions: { parse: [], repliedUser: false },
      });
      return true;
    } catch (error) {
      logger.error?.(`Invite tracker could not send ${title} for ${guild.id}`, error);
      return false;
    }
  }

  function compareSnapshots(previous, current, deletedInvites) {
    const inviteCandidates = Object.values(current.invites)
      .map((invite) => ({
        invite,
        previous: previous.invites[invite.code],
        delta: invite.uses - Number(previous.invites[invite.code]?.uses ?? 0),
      }))
      .filter((candidate) => candidate.delta > 0);
    const vanityDelta = current.vanityUses != null && previous.vanityUses != null
      ? current.vanityUses - previous.vanityUses
      : 0;

    const changedSources = inviteCandidates.length + (vanityDelta > 0 ? 1 : 0);
    if (changedSources === 1 && inviteCandidates.length === 1) {
      const candidate = inviteCandidates[0];
      return {
        attribution: {
          kind: 'invite',
          certainty: 'confirmed',
          code: candidate.invite.code,
          uses: candidate.invite.uses,
          maxUses: candidate.invite.maxUses,
          inviter: candidate.invite.inviter,
          channel: candidate.invite.channel,
        },
        consume: { type: 'invite', code: candidate.invite.code },
      };
    }
    if (changedSources === 1 && vanityDelta > 0) {
      return {
        attribution: { kind: 'vanity', code: current.vanityCode },
        consume: { type: 'vanity' },
      };
    }
    if (changedSources > 1) {
      return {
        attribution: { kind: 'ambiguous' },
        consume: null,
      };
    }

    const now = Date.now();
    const disappeared = [
      ...Object.values(previous.invites)
        .filter((invite) => !current.invites[invite.code])
        .map((invite) => ({ ...invite, deletedAt: now })),
      ...Object.values(deletedInvites ?? {}),
    ].filter((invite) =>
      invite.maxUses > 0
      && invite.uses < invite.maxUses
      && now - (invite.deletedAt ?? now) <= DELETED_INVITE_RETENTION_MS
      && !invite.consumed
    );
    const uniqueDisappeared = [...new Map(disappeared.map((invite) => [invite.code, invite])).values()];
    if (uniqueDisappeared.length === 1) {
      const invite = uniqueDisappeared[0];
      return {
        attribution: {
          kind: 'invite',
          certainty: 'possible',
          code: invite.code,
          uses: invite.uses + 1,
          maxUses: invite.maxUses,
          inviter: invite.inviter,
          channel: invite.channel,
        },
        consume: { type: 'deleted', code: invite.code },
      };
    }
    return { attribution: null, consume: null };
  }

  function consumeSnapshot(previous, current, result) {
    const next = clone(current);
    if (!result?.consume) return next;

    if (result.consume.type === 'invite') {
      const previousUses = Number(previous.invites[result.consume.code]?.uses ?? 0);
      if (next.invites[result.consume.code]) next.invites[result.consume.code].uses = previousUses + 1;
    } else if (result.consume.type === 'vanity' && previous.vanityUses != null) {
      next.vanityUses = previous.vanityUses + 1;
    }
    return next;
  }

  function pruneDeletedInvites(deletedInvites) {
    const cutoff = Date.now() - DELETED_INVITE_RETENTION_MS;
    for (const [code, invite] of Object.entries(deletedInvites)) {
      if ((invite.deletedAt ?? 0) < cutoff || invite.consumed) delete deletedInvites[code];
    }
  }

  async function resolveJoinAttribution(member) {
    const initialCache = cacheFor(member.guild.id);
    if (!initialCache.warmed || !initialCache.snapshot) {
      const current = await fetchSnapshot(member.guild);
      if (current) {
        caches.set(member.guild.id, { warmed: true, snapshot: current, deletedInvites: initialCache.deletedInvites ?? {} });
        await persistSnapshot(member.guild.id, current).catch(() => null);
        return { kind: 'warming' };
      }
      return { kind: 'unavailable' };
    }

    let latest = null;
    for (const delay of JOIN_RETRY_DELAYS_MS) {
      if (delay) await wait(delay);
      const current = await fetchSnapshot(member.guild);
      if (!current) continue;
      latest = current;
      const cache = cacheFor(member.guild.id);
      const comparison = compareSnapshots(cache.snapshot, current, cache.deletedInvites);
      if (comparison.attribution) {
        const nextCache = {
          warmed: true,
          snapshot: consumeSnapshot(cache.snapshot, current, comparison),
          deletedInvites: cache.deletedInvites ?? {},
        };
        if (comparison.consume?.type === 'deleted' && nextCache.deletedInvites[comparison.consume.code]) {
          nextCache.deletedInvites[comparison.consume.code].consumed = true;
        }
        pruneDeletedInvites(nextCache.deletedInvites);
        caches.set(member.guild.id, nextCache);
        await persistSnapshot(member.guild.id, nextCache.snapshot).catch(() => null);
        return comparison.attribution;
      }
    }

    const cache = cacheFor(member.guild.id);
    if (latest) {
      cache.snapshot = latest;
      pruneDeletedInvites(cache.deletedInvites);
      caches.set(member.guild.id, cache);
      await persistSnapshot(member.guild.id, latest).catch(() => null);
    }
    return { kind: 'platform' };
  }

  async function reportMemberJoin(member) {
    const config = await getConfig(member.guild.id);
    if (!config?.channelId) return false;

    return queue(member.guild.id, async () => {
      const attribution = await resolveJoinAttribution(member);
      await persistAttribution(member.guild.id, member.id, attribution);
      const inviter = attribution.kind === 'invite' ? attribution.inviter : null;
      return emit(member.guild, member.user.bot ? 'Bot Added' : 'Member Joined', {
        color: COLORS.success,
        users: [member.user, inviter],
        fields: [
          { name: member.user.bot ? 'Bot' : 'Member', value: `${userLabel(member.user)} (${member.id})`, inline: false },
          ...joinAttributionFields(attribution),
        ],
      });
    });
  }

  async function findRecentAuditEntry(guild, type, targetId) {
    const attempts = [0, 700];
    for (const delay of attempts) {
      if (delay) await wait(delay);
      const logs = await guild.fetchAuditLogs({ type, limit: 8 }).catch(() => null);
      const entry = logs?.entries?.find((candidate) =>
        candidate.target?.id === targetId
        && Date.now() - candidate.createdTimestamp <= AUDIT_LOG_WINDOW_MS
      );
      if (entry) return entry;
    }
    return null;
  }

  function removalKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  async function emitRemoval(guild, user, kind, auditEntry) {
    const attribution = await takeAttribution(guild.id, user.id);
    const executor = userRecord(auditEntry?.executor);
    const isKick = kind === 'kick';
    const isBan = kind === 'ban';
    const title = isBan
      ? (user.bot ? 'Bot Banned' : 'Member Banned')
      : isKick
        ? (user.bot ? 'Bot Kicked' : 'Member Kicked')
        : (user.bot ? 'Bot Removed' : 'Member Left');
    const action = isBan ? 'Banned' : isKick ? 'Kicked' : 'Left';
    const fields = [
      { name: user.bot ? 'Bot' : 'Member', value: `${userLabel(user)} (${user.id})`, inline: false },
      { name: 'Action', value: action, inline: true },
    ];
    if (executor) fields.push({ name: 'Actioned by', value: `${executor.label} (${executor.id})`, inline: true });
    if (auditEntry?.reason) fields.push({ name: 'Reason', value: auditEntry.reason, inline: false });
    fields.push(...joinAttributionFields(attribution));

    removalReports.set(removalKey(guild.id, user.id), { kind, at: Date.now() });
    return emit(guild, title, {
      color: isBan || isKick ? COLORS.danger : COLORS.neutral,
      users: [user, executor],
      fields,
    });
  }

  async function reportMemberRemove(member) {
    const config = await getConfig(member.guild.id);
    if (!config?.channelId) return false;
    const key = removalKey(member.guild.id, member.id);
    if (removalReports.has(key)) return false;

    // Discord emits the generic remove event for voluntary leaves, kicks, and
    // bans. Give the specific ban event/audit record a brief chance to arrive.
    await wait(MEMBER_REMOVE_WAIT_MS);
    if (recentBans.has(key) || removalReports.has(key)) return false;

    const banEntry = await findRecentAuditEntry(member.guild, AuditLogEvent.MemberBanAdd, member.id);
    if (banEntry) {
      recentBans.set(key, Date.now());
      return emitRemoval(member.guild, member.user, 'ban', banEntry);
    }
    const kickEntry = await findRecentAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id);
    if (kickEntry) return emitRemoval(member.guild, member.user, 'kick', kickEntry);
    return emitRemoval(member.guild, member.user, 'leave', null);
  }

  async function reportGuildBanAdd(ban) {
    const guild = ban.guild;
    const user = ban.user;
    if (!guild || !user) return false;
    const config = await getConfig(guild.id);
    if (!config?.channelId) return false;

    const key = removalKey(guild.id, user.id);
    recentBans.set(key, Date.now());
    const existing = removalReports.get(key);
    if (existing?.kind === 'ban') return false;
    const auditEntry = await findRecentAuditEntry(guild, AuditLogEvent.MemberBanAdd, user.id);
    return emitRemoval(guild, user, 'ban', auditEntry);
  }

  async function reportGuildBanRemove(ban) {
    const guild = ban.guild;
    const user = ban.user;
    if (!guild || !user) return false;
    const auditEntry = await findRecentAuditEntry(guild, AuditLogEvent.MemberBanRemove, user.id);
    const executor = userRecord(auditEntry?.executor);
    return emit(guild, user.bot ? 'Bot Unbanned' : 'Member Unbanned', {
      color: COLORS.success,
      users: [user, executor],
      fields: [
        { name: user.bot ? 'Bot' : 'Member', value: `${userLabel(user)} (${user.id})`, inline: false },
        ...(executor ? [{ name: 'Actioned by', value: `${executor.label} (${executor.id})`, inline: true }] : []),
        ...(auditEntry?.reason ? [{ name: 'Reason', value: auditEntry.reason, inline: false }] : []),
      ],
    });
  }

  async function reportInviteCreate(invite) {
    const guild = invite.guild;
    if (!guild) return false;
    const normalized = normalizeInvite(invite);
    await queue(guild.id, async () => {
      const cache = cacheFor(guild.id);
      if (cache.warmed && cache.snapshot) {
        cache.snapshot.invites[normalized.code] = normalized;
        delete cache.deletedInvites[normalized.code];
        caches.set(guild.id, cache);
        await persistSnapshot(guild.id, cache.snapshot).catch(() => null);
      }
    });
    return emit(guild, 'Invite Created', {
      color: COLORS.info,
      users: [normalized.inviter],
      channels: [normalized.channel],
      fields: inviteFields(normalized),
    });
  }

  async function reportInviteDelete(invite) {
    const guild = invite.guild;
    if (!guild) return false;
    let normalized = normalizeInvite(invite);
    await queue(guild.id, async () => {
      const cache = cacheFor(guild.id);
      const known = cache.snapshot?.invites?.[normalized.code];
      normalized = known ?? normalized;
      if (cache.warmed && cache.snapshot) {
        delete cache.snapshot.invites[normalized.code];
        cache.deletedInvites[normalized.code] = { ...normalized, deletedAt: Date.now() };
        pruneDeletedInvites(cache.deletedInvites);
        caches.set(guild.id, cache);
        await persistSnapshot(guild.id, cache.snapshot).catch(() => null);
      }
    });
    return emit(guild, 'Invite Deleted', {
      color: COLORS.warning,
      users: [normalized.inviter],
      channels: [normalized.channel],
      fields: [
        ...inviteFields(normalized),
        {
          name: 'Note',
          value: normalized.maxUses > 0
            ? 'Discord can also delete an invite when it expires or reaches its use limit.'
            : 'Discord does not reveal who deleted an invite in this gateway event.',
          inline: false,
        },
      ],
    });
  }

  function permissionsFor(guild, channel) {
    const member = guild.members.me;
    const channelPermissions = member && channel ? channel.permissionsFor(member) : null;
    const guildPermissions = member?.permissions;
    return {
      canSend: Boolean(channelPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])),
      canReadInvites: Boolean(guildPermissions?.has(PermissionFlagsBits.ManageGuild)),
      canReadAuditLog: Boolean(guildPermissions?.has(PermissionFlagsBits.ViewAuditLog)),
      canReceiveBanEvents: Boolean(guildPermissions?.has(PermissionFlagsBits.ViewAuditLog) || guildPermissions?.has(PermissionFlagsBits.BanMembers)),
    };
  }

  async function setup(guild, channel) {
    const permissions = permissionsFor(guild, channel);
    const baseline = await warmGuild(guild);
    await setConfig(guild.id, {
      channelId: channel.id,
      configuredAt: new Date().toISOString(),
    });
    return { ...permissions, baseline };
  }

  async function disable(guild) {
    await clearConfig(guild.id);
  }

  async function status(guild) {
    const config = await getConfig(guild.id);
    const cache = cacheFor(guild.id);
    const channel = config?.channelId
      ? await guild.channels.fetch(config.channelId).catch(() => null)
      : null;
    return {
      enabled: Boolean(config?.channelId),
      channel,
      permissions: permissionsFor(guild, channel),
      baselineReady: Boolean(cache.warmed && cache.snapshot),
      baselineCapturedAt: cache.snapshot?.capturedAt ?? null,
      inviteCount: Object.keys(cache.snapshot?.invites ?? {}).length,
    };
  }

  async function sendTest(guild, scenario, actor) {
    const actorRecord = userRecord(actor);
    const examples = {
      inviter: () => emit(guild, 'Member Joined', {
        color: COLORS.success,
        users: [actorRecord, actorRecord],
        fields: [
          { name: 'Member', value: `${actorRecord.label} (${actorRecord.id})`, inline: false },
          { name: 'Join source', value: 'Invite `example`', inline: true },
          { name: 'Invited by', value: `${actorRecord.label} (${actorRecord.id})`, inline: false },
        ],
      }),
      vanity: () => emit(guild, 'Member Joined', {
        color: COLORS.success,
        users: [actorRecord],
        fields: [
          { name: 'Member', value: `${actorRecord.label} (${actorRecord.id})`, inline: false },
          { name: 'Join source', value: 'Server vanity URL `vanity-url`', inline: false },
        ],
      }),
      unknown: () => emit(guild, 'Member Joined', {
        color: COLORS.warning,
        users: [actorRecord],
        fields: [
          { name: 'Member', value: `${actorRecord.label} (${actorRecord.id})`, inline: false },
          { name: 'Join source', value: 'Discord non-invite join flow or unavailable/deleted invite', inline: false },
        ],
      }),
      'bot-join': () => emit(guild, 'Bot Added', {
        color: COLORS.success,
        users: [actorRecord],
        fields: [
          { name: 'Bot', value: 'Example Bot (000000000000000000)', inline: false },
          { name: 'Join source', value: 'Invite `example`', inline: true },
        ],
      }),
      leave: () => emit(guild, 'Member Left', {
        color: COLORS.neutral,
        users: [actorRecord],
        fields: [{ name: 'Member', value: `${actorRecord.label} (${actorRecord.id})`, inline: false }],
      }),
      'bot-leave': () => emit(guild, 'Bot Removed', {
        color: COLORS.neutral,
        fields: [{ name: 'Bot', value: 'Example Bot (000000000000000000)', inline: false }],
      }),
    };
    return examples[scenario]?.() ?? false;
  }

  return {
    disable,
    reportGuildBanAdd,
    reportGuildBanRemove,
    reportInviteCreate,
    reportInviteDelete,
    reportMemberJoin,
    reportMemberRemove,
    sendTest,
    setup,
    status,
    warmGuild,
  };
}

module.exports = { createInviteTracker };
