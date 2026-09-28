const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const pointOption = (builder) =>
  builder
    .setName('points')
    .setDescription('Number of SSP')
    .setRequired(true)
    .setMinValue(1);

const userOption = (builder) =>
  builder
    .setName('user')
    .setDescription('Discord user')
    .setRequired(true);

const optionalUserOption = (builder) =>
  builder
    .setName('user')
    .setDescription('Only delete messages from this user')
    .setRequired(false);

const reasonOption = (builder) =>
  builder
    .setName('reason')
    .setDescription('Reason for this action')
    .setRequired(false);

const countOption = (builder) =>
  builder
    .setName('count')
    .setDescription('Number of messages to delete')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(1000);

const durationOption = (builder) =>
  builder
    .setName('duration')
    .setDescription('Timeout duration')
    .setRequired(true)
    .setMinValue(1);

const unitOption = (builder) =>
  builder
    .setName('unit')
    .setDescription('Timeout duration unit')
    .setRequired(true)
    .addChoices(
      { name: 'Minutes', value: 'minutes' },
      { name: 'Hours', value: 'hours' },
      { name: 'Days', value: 'days' }
    );

const punishCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addUserOption(userOption)
    .addStringOption(reasonOption);

const undoCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addUserOption(userOption);

const marinateCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addUserOption(userOption)
    .addIntegerOption(durationOption)
    .addStringOption(unitOption)
    .addStringOption(reasonOption);

const purgeCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addIntegerOption(countOption)
    .addUserOption(optionalUserOption);

const allPurgeCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addUserOption(userOption)
    .addIntegerOption(countOption);

const lockdownCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption(reasonOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const archiveCommand = new SlashCommandBuilder()
  .setName('archive')
  .setDescription('Lock and move this chat into an archive category')
  .addIntegerOption((option) =>
    option
      .setName('archive')
      .setDescription('Archive number, for example 1 for Archive 1')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(999)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const announceCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Publish an official server announcement')
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('Announcement text; supports Markdown, Unicode, and server emojis')
      .setRequired(true)
      .setMaxLength(2000)
  )
  .addStringOption((option) =>
    option
      .setName('format')
      .setDescription('How the announcement should look')
      .setRequired(true)
      .addChoices(
        { name: 'Branded embed', value: 'embed' },
        { name: 'Normal message', value: 'message' }
      )
  )
  .addChannelOption((option) =>
    option.setName('channel').setDescription('Where to publish it; defaults to this channel')
  )
  .addStringOption((option) =>
    option.setName('title').setDescription('Embed title (optional)').setMaxLength(256)
  )
  .addStringOption((option) =>
    option.setName('link').setDescription('Full https:// link to include').setMaxLength(700)
  )
  .addStringOption((option) =>
    option.setName('link_text').setDescription('Text shown for the optional link').setMaxLength(256)
  )
  .addAttachmentOption((option) =>
    option.setName('attachment').setDescription('One file to attach')
  )
  .addStringOption((option) =>
    option.setName('image').setDescription('Image URL for the bottom of an embed')
  )
  .addStringOption((option) =>
    option.setName('thumbnail').setDescription('Image URL for the embed thumbnail')
  )
  .addStringOption((option) =>
    option.setName('footer').setDescription('Embed footer text').setMaxLength(2048)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const memberMessageSetupCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addChannelOption((option) =>
      option.setName('channel').setDescription('Channel for these messages').setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Embed text; use {user}, {username}, {server}, or {memberCount}')
        .setRequired(true)
        .setMaxLength(2000)
    )
    .addStringOption((option) =>
      option.setName('title').setDescription('Embed title (optional)').setMaxLength(256)
    )
    .addStringOption((option) =>
      option.setName('footer').setDescription('Embed footer text (optional)').setMaxLength(2048)
    )
    .addStringOption((option) =>
      option.setName('image').setDescription('Main embed image URL (optional)').setMaxLength(2000)
    )
    .addStringOption((option) =>
      option.setName('thumbnail').setDescription('Embed thumbnail URL (optional)').setMaxLength(2000)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const autoReactCommand = new SlashCommandBuilder()
  .setName('autoreact')
  .setDescription('Configure automatic reactions in one channel')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription('Choose what messages receive a reaction')
      .addStringOption((option) =>
        option.setName('emoji').setDescription('Emoji to add, such as 👍 or <:name:id>').setRequired(true)
      )
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel to watch')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addStringOption((option) =>
        option
          .setName('filter')
          .setDescription('Which messages should receive the reaction')
          .setRequired(true)
          .addChoices(
            { name: 'All messages', value: 'all' },
            { name: 'Messages with any attachment', value: 'attachments' },
            { name: 'Images only', value: 'images' },
            { name: 'Videos only', value: 'videos' }
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('disable').setDescription('Turn off automatic reactions for this server')
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const honeypotCommand = new SlashCommandBuilder()
  .setName('honeypot')
  .setDescription('Configure a channel that times out anyone who posts in it')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription('Enable the honeypot')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel to use as the honeypot')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addChannelOption((option) =>
        option
          .setName('log_channel')
          .setDescription('Where honeypot actions are reported')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addIntegerOption(durationOption)
      .addStringOption(unitOption)
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('disable').setDescription('Turn off the honeypot for this server')
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const inviteTrackerCommand = new SlashCommandBuilder()
  .setName('invites')
  .setDescription('Configure join invite tracking')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription('Send invite attribution for new members to a channel')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel for join-invite reports')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('disable').setDescription('Turn off invite tracking reports')
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('test').setDescription('Show test buttons for every invite-tracker scenario')
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const roleTagCommand = new SlashCommandBuilder()
  .setName('roletag')
  .setDescription('Apply moderation actions when a member name contains a tag')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a tag rule')
      .addStringOption((option) =>
        option.setName('tag').setDescription('Text to find in usernames or display names').setRequired(true).setMaxLength(100)
      )
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription('What happens when the tag matches')
          .setRequired(true)
          .addChoices(
            { name: 'Give a role', value: 'role' },
            { name: 'Kick the member', value: 'kick' },
            { name: 'Ban the member', value: 'ban' }
          )
      )
      .addRoleOption((option) =>
        option.setName('role').setDescription('Role to give (required only for the role action)')
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove every rule for one tag')
      .addStringOption((option) =>
        option.setName('tag').setDescription('Exact tag text to remove').setRequired(true).setMaxLength(100)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List the configured tag rules')
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add SSP to a user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove SSP from a user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the Sunnah Shield Points leaderboard'),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Give your SSP to another user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption),

  punishCommand('grill', 'Apply Grill to a user'),
  punishCommand('sgrill', 'Apply Super Grill to a user'),
  punishCommand('jail', 'Apply Jail to a user'),
  punishCommand('naughty', 'Apply Naughty to a user'),
  punishCommand('deepfry', 'Ban a user'),
  marinateCommand('marinate', 'Timeout a user'),
  undoCommand('ungrill', 'Remove Grill from a user'),
  undoCommand('unsgrill', 'Remove Super Grill from a user'),
  undoCommand('unjail', 'Remove Jail from a user'),
  undoCommand('unnaughty', 'Remove Naughty from a user'),
  undoCommand('undeepfry', 'Unban a user'),
  undoCommand('unmarinate', 'Remove timeout from a user'),
  purgeCommand('purge', 'Delete messages in this channel'),
  allPurgeCommand('allpurge', 'Delete messages from a user across all channels'),
  lockdownCommand('lockdown', 'Hide every channel from non-admin members'),
  archiveCommand,
  announceCommand,
  memberMessageSetupCommand('welcome-setup', 'Configure the welcome embed sent to new members'),
  memberMessageSetupCommand('booster-setup', 'Configure the embed sent to new server boosters'),
  autoReactCommand,
  honeypotCommand,
  inviteTrackerCommand,
  roleTagCommand,
  new SlashCommandBuilder()
    .setName('welcome-test')
    .setDescription('Send the configured welcome embed using your profile as the preview')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('booster-test')
    .setDescription('Send the configured booster embed using your profile as the preview')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show bot command help'),

  punishCommand('شوي', 'Apply Grill to a user'),
  punishCommand('شوي_اوي', 'Apply Super Grill to a user'),
  punishCommand('سجن', 'Apply Jail to a user'),
  punishCommand('نوتي', 'Apply Naughty to a user'),
  punishCommand('قلي', 'Ban a user'),
  marinateCommand('تتبيل', 'Timeout a user'),
  undoCommand('فك_شوي', 'Remove Grill from a user'),
  undoCommand('فك_شوي_اوي', 'Remove Super Grill from a user'),
  undoCommand('فك_سجن', 'Remove Jail from a user'),
  undoCommand('فك_نوتي', 'Remove Naughty from a user'),
  undoCommand('فك_قلي', 'Unban a user'),
  undoCommand('فك_تتبيل', 'Remove timeout from a user'),
  purgeCommand('مسح', 'Delete messages in this channel'),
  allPurgeCommand('مسح_الكل', 'Delete messages from a user across all channels'),
  new SlashCommandBuilder()
    .setName('مساعدة')
    .setDescription('Show bot command help'),
];

module.exports = {
  commands,
};
