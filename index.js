require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType
} = require('@discordjs/voice');

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');

const MAX_JOIN_RETRIES = parseInt(process.env.MAX_JOIN_RETRIES, 10) || 3;
const JOIN_STAGGER_MS = process.env.JOIN_STAGGER_MS ? parseInt(process.env.JOIN_STAGGER_MS, 10) : 0;
const JOIN_CONCURRENCY = process.env.JOIN_CONCURRENCY ? parseInt(process.env.JOIN_CONCURRENCY, 10) : 10;
const joinQueue = [];
const activeJoinTasks = new Set();
let joinQueueProcessing = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processJoinQueue = async () => {
  if (joinQueueProcessing) return;
  joinQueueProcessing = true;
  while (joinQueue.length > 0 || activeJoinTasks.size > 0) {
    while (joinQueue.length > 0 && activeJoinTasks.size < JOIN_CONCURRENCY) {
      const task = joinQueue.shift();
      const promise = task().catch(err => console.error('[JoinQueue] task failed:', err?.message || err)).finally(() => {
        activeJoinTasks.delete(promise);
      });
      activeJoinTasks.add(promise);
      if (JOIN_STAGGER_MS > 0) await sleep(JOIN_STAGGER_MS);
    }
    if (activeJoinTasks.size > 0) {
      await Promise.race(activeJoinTasks);
    }
  }
  joinQueueProcessing = false;
};

const enqueueJoinTask = (task) => {
  joinQueue.push(task);
  if (!joinQueueProcessing) {
    void processJoinQueue();
  }
};

// Use @discordjs/opus for voice encoding instead of opusscript for better performance.
// libsodium-wrappers is not needed explicitly unless you use custom encryption logic.

// Health check
const PORT = process.env.PORT || 8080;
const healthServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('10 Bots - Nuclear Stacked');
});

healthServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[Health] Port ${PORT} in use; skipping health server.`);
  } else {
    console.error('[Health] Server error:', err);
  }
});

healthServer.listen(PORT, () => {
  console.log(`[Health] Listening on port ${PORT}`);
  console.log(`[System] Join config: ${JOIN_CONCURRENCY} concurrency, ${JOIN_STAGGER_MS}ms stagger`);
});

const tokens = Object.entries(process.env)
  .filter(([key, value]) => /^TOKEN\d+$/i.test(key) && value)
  .sort((a, b) => {
    const aIndex = parseInt(a[0].match(/\d+/)[0], 10);
    const bIndex = parseInt(b[0].match(/\d+/)[0], 10);
    return aIndex - bIndex;
  })
  .map(([, value]) => value);

if (!tokens.length) {
  throw new Error('No TOKEN environment variables found. Please set TOKEN1, TOKEN2, ...');
}

let sharedPlayer = null;
let playbackStarting = false;
let playbackStarted = false;
let playbackQueued = false;
const botInstances = [];

const createSharedPlayer = () => {
  if (sharedPlayer) return sharedPlayer;
  sharedPlayer = createAudioPlayer();

  sharedPlayer.on('error', err => {
    console.error('[Shared Player] Error:', err.message || err);
  });

  sharedPlayer.on('stateChange', (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Playing) {
      console.log('[Shared Player] Audio is now playing');
    } else if (newState.status === AudioPlayerStatus.Idle) {
      console.log('[Shared Player] Audio player is idle');
    }
  });

  return sharedPlayer;
};

const subscribeConnectionToSharedPlayer = (bot) => {
  const conn = bot.getConnection();
  if (!conn || conn.state?.status !== VoiceConnectionStatus.Ready) {
    console.warn(`[Bot ${bot.botNum}] Cannot subscribe to shared player: connection not ready`);
    return null;
  }

  if (bot.getSubscription()) {
    return bot.getSubscription();
  }

  const player = createSharedPlayer();
  const subscription = conn.subscribe(player);
  if (!subscription) {
    console.warn(`[Bot ${bot.botNum}] Shared player subscription returned null`);
    return null;
  }

  console.log(`[Bot ${bot.botNum}] Subscribed to shared player`);
  bot.setSubscription(subscription);
  return subscription;
};

const waitForReadyConnections = async (bots, timeoutMs = 15000) => {
  const readyPromises = bots.map(bot => {
    const conn = bot.getConnection();
    if (!conn) return Promise.resolve(false);
    if (conn.state?.status === VoiceConnectionStatus.Ready) return Promise.resolve(true);
    return entersState(conn, VoiceConnectionStatus.Ready, timeoutMs)
      .then(() => true)
      .catch(() => false);
  });

  const results = await Promise.all(readyPromises);
  return bots.filter((_, index) => results[index]);
};

const queueSharedPlayback = () => {
  if (!playbackQueued) {
    playbackQueued = true;
    console.log('[Shared Player] Playback queued until all connected bots are ready');
  }
};

const checkPlaybackQueue = async () => {
  if (!playbackQueued || playbackStarted || playbackStarting) return;

  const connectedBots = botInstances.filter(bot => bot.getConnection());
  if (!connectedBots.length) return;

  const readyBots = connectedBots.filter(bot => bot.getConnection().state?.status === VoiceConnectionStatus.Ready);
  if (!readyBots.length) return;

  playbackQueued = false;
  console.log('[Shared Player] One or more connected bots are ready; auto-starting queued playback');
  await startSharedPlayback();
};

const createAudioResourceFromFile = (audioPath) => {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  console.log('[Shared Player] Creating audio resource from file:', audioPath);
  console.log('[Shared Player] Using ffmpeg executable:', ffmpegPath);

  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', audioPath,
    '-ac', '2',
    '-ar', '48000',
    '-f', 's16le',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', data => {
    console.error('[Shared Player] FFmpeg stderr:', data.toString());
  });

  ffmpeg.on('error', err => {
    console.error('[Shared Player] FFmpeg spawn error:', err?.message || err);
  });

  const opusEncoder = new prism.opus.Encoder({
    rate: 48000,
    channels: 2,
    frameSize: 960
  });

  ffmpeg.stdout.on('error', err => {
    console.error('[Shared Player] FFmpeg stdout error:', err?.message || err);
  });

  opusEncoder.on('error', err => {
    console.error('[Shared Player] Opus encoder error:', err?.message || err);
  });

  const resource = createAudioResource(ffmpeg.stdout.pipe(opusEncoder), {
    inlineVolume: true,
    inputType: StreamType.Opus
  });

  if (resource.playStream && typeof resource.playStream.on === 'function') {
    resource.playStream.on('error', err => {
      console.error('[Shared Player] Resource playStream error:', err?.message || err);
    });
    resource.playStream.on('end', () => {
      console.log('[Shared Player] Resource playStream ended');
    });
  }

  return resource;
};

const playSharedAudio = async (audioPath) => {
  try {
    const player = createSharedPlayer();
    const resource = createAudioResourceFromFile(audioPath);
    resource.volume?.setVolume(1.0);

    player.play(resource);
    console.log('[Shared Player] Started playback');
    return true;
  } catch (err) {
    console.error('[Shared Player] Playback failed:', err.message || err);
    return false;
  }
};

const stopSharedAudio = () => {
  if (!sharedPlayer) return;
  try {
    sharedPlayer.stop(true);
  } catch (err) {
    console.error('[Shared Player] Stop failed:', err.message || err);
  }

  botInstances.forEach(bot => {
    const sub = bot.getSubscription();
    if (sub) {
      try { sub.unsubscribe(); } catch (e) {}
      bot.setSubscription(null);
    }
  });

  sharedPlayer = null;
  playbackStarted = false;
  playbackStarting = false;
};

console.log(`Starting ${tokens.length} bots in NUCLEAR STACKED mode...`);

let sharedChstStartTime = 0;
const getSharedChstStartTime = () => {
  if (sharedChstStartTime <= Date.now()) {
    sharedChstStartTime = Date.now() + 1500;
  }
  return sharedChstStartTime;
};

tokens.forEach((token, index) => {
  const botNum = index + 1;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  const slashCommands = [
    { name: 'bkva', description: 'Make the bot join your voice channel' },
    { name: 'bkst', description: 'Start audio playback (10x repeat)' },
    { name: 'bksp', description: 'Stop audio playback' },
    { name: 'bklv', description: 'Leave the voice channel' }
  ];

  let connection;
  let subscription = null;
  let isJoining = false;
  let lastVoiceChannelId = null;
  let lastGuildId = null;

  const botInstance = {
    botNum,
    getConnection: () => connection,
    setConnection: (conn) => { connection = conn; },
    getSubscription: () => subscription,
    setSubscription: (sub) => { subscription = sub; }
  };
  botInstances.push(botInstance);

   // Use separate audio file for each bot (but shared playback uses one file path)
   const audioPath = path.join(__dirname, `audio${botNum}.mp3`);
   const sharedAudioPath = path.join(__dirname, 'audio1.mp3');

  // ========== AUDIO SYSTEM ==========

  const startSharedPlayback = async () => {
    if (playbackStarted || playbackStarting) {
      console.log(`[Bot ${botNum}] Shared playback already active or starting`);
      return playbackStarted;
    }

    playbackStarting = true;
    try {
      if (!fs.existsSync(sharedAudioPath)) {
        console.error(`[Bot ${botNum}] Shared audio file not found: ${sharedAudioPath}`);
        return false;
      }

      const connectedBots = botInstances.filter(bot => bot.getConnection());
      if (!connectedBots.length) {
        console.warn(`[Bot ${botNum}] No bot voice connections available for shared playback`);
        return false;
      }

      const readyBots = await waitForReadyConnections(connectedBots, 15000);
      if (readyBots.length === 0) {
        console.warn(`[Bot ${botNum}] No ready bot connections available for playback. Playback will be queued.`);
        queueSharedPlayback();
        return false;
      }

      if (readyBots.length !== connectedBots.length) {
        const notReady = connectedBots.length - readyBots.length;
        console.warn(`[Bot ${botNum}] ${notReady} connected bot(s) are not ready yet. Starting playback on ${readyBots.length} ready bot(s).`);
      }

      readyBots.forEach(bot => subscribeConnectionToSharedPlayer(bot));
      console.log(`[Bot ${botNum}] Shared audio subscribed ${readyBots.length} bots before playback`);

      const player = createSharedPlayer();
      const resource = createAudioResourceFromFile(sharedAudioPath);
      resource.volume?.setVolume(1.0);

      player.play(resource);
      console.log(`[Bot ${botNum}] Shared audio resource playing from ${sharedAudioPath}`);

      playbackStarted = true;
      return true;
    } catch (err) {
      console.error(`[Bot ${botNum}] Shared playback failed:`, err.message || err);
      return false;
    } finally {
      playbackStarting = false;
    }
  };

  const stopPlayback = () => {
    console.log(`[Bot ${botNum}] stopPlayback called`);
    stopSharedAudio();
  };

  const safeDestroy = (conn) => {
    try {
      if (!conn) return;
      try { conn.removeAllListeners(); } catch (e) {}
      const status = conn.state?.status;
      if (status && status !== VoiceConnectionStatus.Destroyed) {
        conn.destroy();
      }
    } catch (e) {}
  };

  // ========== VOICE CONNECTION ==========

  const attemptJoinVoiceChannel = async (vc, guild, reply, attempt = 1) => {
    try {
      if (connection) {
        try { connection.removeAllListeners(); } catch (e) {}
        safeDestroy(connection);
        connection = null;
      }

      console.log(`[Bot ${botNum}] Joining voice channel ${vc.id} (attempt ${attempt})`);
      
      connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        group: client.user.id
      });
      try { connection.setMaxListeners(30); } catch (e) {}

      connection.on('error', err => {
        console.error(`[Bot ${botNum}] Connection error:`, err?.message || err);
      });

      connection.on(VoiceConnectionStatus.Signalling, () => {
        console.log(`[Bot ${botNum}] Voice signalling`);
      });

      connection.on(VoiceConnectionStatus.Connecting, () => {
        console.log(`[Bot ${botNum}] Voice connecting`);
      });
      
      connection.on(VoiceConnectionStatus.Ready, async () => {
        console.log(`[Bot ${botNum}] Voice ready`);
        await checkPlaybackQueue();
      });
      
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log(`[Bot ${botNum}] Disconnected`);
        stopPlayback();
      });
      
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log(`[Bot ${botNum}] Destroyed`);
        stopPlayback();
      });

      if (connection.state?.status !== VoiceConnectionStatus.Ready) {
        await entersState(connection, VoiceConnectionStatus.Ready, 20000);
      }
      console.log(`[Bot ${botNum}] Joined ✅`);
      await reply('✅ Joined your voice channel.');
    } catch (err) {
      console.error(`[Bot ${botNum}] Join error (attempt ${attempt}):`, err?.message || err);
      safeDestroy(connection);
      connection = null;
      if (attempt < MAX_JOIN_RETRIES) {
        const retryDelay = 800 * attempt;
        await sleep(retryDelay);
        return attemptJoinVoiceChannel(vc, guild, reply, attempt + 1);
      }
      await reply('❌ Failed to join after multiple attempts.');
    } finally {
      if (attempt === 1) {
        isJoining = false;
      }
    }
  };

  // ========== COMMANDS ==========

  const allowedRoleIds = (process.env.ALLOWED_ROLE_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);

  const handleBotCommand = async (commandName, reply, guild, member) => {
    console.log(`[Bot ${botNum}] Command received: ${commandName}`);
    
    if (!guild || !member) {
      console.log(`[Bot ${botNum}] Command failed: missing guild/member`);
      return reply('Command failed: missing guild or member data.');
    }

    const isAdmin = member.permissions.has('Administrator');
    const hasAllowedRole = allowedRoleIds.length > 0 &&
      allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

    if (!isAdmin && !hasAllowedRole) {
      console.log(`[Bot ${botNum}] Permission denied for ${commandName}`);
      if (allowedRoleIds.length === 0) {
        return reply('❌ You need **Administrator** permissions to use this command.');
      }
      const roleMentions = allowedRoleIds
        .map(id => `<@&${id}>`)
        .join(', ');
      return reply(`❌ You need **Administrator** permissions or one of these roles to use this command: ${roleMentions}`);
    }

    if (commandName === 'bkva') {
      if (isJoining) return reply('Already joining...');
      const vc = member.voice.channel;
      if (!vc) return reply('You need to be in a voice channel first.');
      isJoining = true;
      enqueueJoinTask(async () => {
        await attemptJoinVoiceChannel(vc, guild, reply);
      });
      return;
    }

    if (commandName === 'bkst') {
      console.log(`[Bot ${botNum}] bkst command: checking connection...`);
      if (!connection) {
        return reply('❌ Bot is not in a voice channel. Use !bkva to join first.');
      }
      console.log(`[Bot ${botNum}] Connection status: ${connection.state?.status}`);

      if (connection.state?.status !== VoiceConnectionStatus.Ready) {
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 10000);
          console.log(`[Bot ${botNum}] Connection is ready for playback`);
        } catch (err) {
          console.error(`[Bot ${botNum}] Connection not ready for playback:`, err?.message || err);
          return reply('Bot is still joining voice. Please retry in a few seconds.');
        }
      }
      
      console.log(`[Bot ${botNum}] bkst: starting shared playback`);
      const started = await startSharedPlayback();
      if (!started) {
        return reply('❌ Failed to start shared playback.');
      }
      return reply('🔥 BOOGEYMAN 10x REPEAT ACTIVATED');
    }

    if (commandName === 'bksp') {
      stopPlayback();
      return reply('✅ Audio stopped.');
    }

    if (commandName === 'bklv') {
      stopPlayback();
      safeDestroy(connection);
      connection = null;
      return reply('✅ Left voice channel.');
    }

    if (commandName === 'status') {
      try {
        const connState = connection ? (connection.state?.status) : 'not connected';
        const playerState = sharedPlayer ? (sharedPlayer.state?.status) : 'no shared player';
        const msg = `Connection: ${connState}\nShared Player: ${playerState}`;
        await reply(msg);
      } catch (e) {
        console.error(`[Bot ${botNum}] Status error:`, e.message);
        await reply('Failed to retrieve status.');
      }
      return;
    }

    return reply('Unknown command.');
  };

  // ========== CLIENT EVENTS ==========

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const content = message.content.trim().toLowerCase();
    if (!['!bkva', '!bkst', '!bksp', '!bklv', '!status'].includes(content)) return;

    console.log(`[Bot ${botNum}] Message received: "${content}" from ${message.author.username}`);

    const reply = async text => {
      if (botNum !== 1) return;
      try {
        await message.reply(text).catch(() => {});
      } catch (err) {}
    };

    await handleBotCommand(content.slice(1), reply, message.guild, message.member);
  });

  client.on('ready', async () => {
    console.log(`[Bot ${botNum}] Online ✅`);

    try {
      if (client.application?.commands && typeof client.application.commands.set === 'function') {
        await client.application.commands.set(slashCommands);
        console.log(`[Bot ${botNum}] Registered global slash commands`);
      } else {
        const guilds = await client.guilds.fetch();
        for (const [guildId, guild] of guilds) {
          if (guild?.commands && typeof guild.commands.set === 'function') {
            await guild.commands.set(slashCommands);
          }
        }
        console.log(`[Bot ${botNum}] Registered slash commands in ${guilds.size} guild(s)`);
      }
    } catch (err) {
      console.error(`[Bot ${botNum}] Slash command registration failed: ${err.message}`);
    }

    // Pre-load audio for instant playback
// preloadAudio removed - shared player will create resources on demand

    // No automatic voice join or playback on ready. Voice control happens only through commands.
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.bot) return;

    console.log(`[Bot ${botNum}] Slash command received: /${interaction.commandName} from ${interaction.user.username}`);

    const reply = async (content) => {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    };

    await handleBotCommand(interaction.commandName, reply, interaction.guild, interaction.member);
  });

  client.login(token).catch(err => {
    console.error(`[Bot ${botNum}] LOGIN FAILED: ${err.message}`);
    if (err.code) console.error(`[Bot ${botNum}] ERROR CODE: ${err.code}`);
  });
});