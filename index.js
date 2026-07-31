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
const { PassThrough } = require('stream');
const ffmpegPath = require('ffmpeg-static');

// Ensure ffmpeg is accessible for prism-media fallback
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const MAX_JOIN_RETRIES = parseInt(process.env.MAX_JOIN_RETRIES, 10) || 3;
const JOIN_STAGGER_MS = parseInt(process.env.JOIN_STAGGER_MS, 10) || 300;
const JOIN_CONCURRENCY = parseInt(process.env.JOIN_CONCURRENCY, 10) || 3;
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

require('opusscript');
require('libsodium-wrappers');

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
  let player;
  let stopRequested = false;
  let isJoining = false;
  let audioPlayCount = 0;
  let maxAudioPlays = 10;
  let playbackTimeout = null;
  let currentFfmpeg = null;
  let currentResource = null;

  // Use PCM files - they are pre-converted and already in the correct format
  const audioPath = path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${botNum}.pcm`);

  // ========== AUDIO SYSTEM ==========

  // Creates a fresh audio resource by spawning ffmpeg to transcode PCM to Opus
  // This is the most reliable approach for Discord voice
  const createResource = () => {
    if (!fs.existsSync(audioPath)) {
      console.error(`[Bot ${botNum}] Audio file not found: ${audioPath}`);
      return null;
    }

    // Kill any existing ffmpeg process
    if (currentFfmpeg) {
      try { currentFfmpeg.kill('SIGKILL'); } catch (e) {}
      currentFfmpeg = null;
    }

    // Spawn ffmpeg: read PCM file -> encode to Opus -> pipe to stdout
    // Using libopus encoder directly for best quality and compatibility
    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-f', 's16le',        // Input format: signed 16-bit little-endian PCM
      '-ar', '48000',        // Input sample rate: 48kHz
      '-ac', '2',            // Input channels: stereo
      '-i', audioPath,       // Input file
      '-c:a', 'libopus',     // Encode to Opus
      '-b:a', '96k',         // Bitrate: 96kbps (good quality)
      '-ar', '48000',        // Output sample rate: 48kHz
      '-ac', '2',            // Output channels: stereo
      '-f', 'ogg',           // Output format: Ogg container
      '-frame_duration', '20', // 20ms frames (standard for Discord)
      '-packet_loss', '1',   // Enable packet loss concealment
      '-application', 'audio', // Optimize for audio
      '-vbr', 'on',          // Variable bitrate
      'pipe:1'               // Output to stdout
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Bot ${botNum}] FFmpeg error:`, err.message);
    });

    ffmpeg.stderr.on('data', () => {
      // ffmpeg diagnostic logs go to stderr - ignore for now
    });

    // Create a PassThrough to buffer the ffmpeg output
    // This prevents backpressure issues
    const passThrough = new PassThrough();
    ffmpeg.stdout.pipe(passThrough);

    // Create the audio resource from the Ogg/Opus stream
    const resource = createAudioResource(passThrough, {
      inputType: StreamType.OggOpus,
      inlineVolume: true
    });

    // Store references for cleanup
    currentFfmpeg = ffmpeg;
    currentResource = resource;

    // Cleanup handlers
    resource.on('end', () => {
      console.log(`[Bot ${botNum}] Resource ended`);
      cleanupFfmpeg();
    });

    resource.on('error', (err) => {
      console.error(`[Bot ${botNum}] Resource error:`, err.message);
      cleanupFfmpeg();
    });

    // Cleanup ffmpeg when resource is done
    const cleanupFfmpeg = () => {
      if (currentFfmpeg) {
        try { currentFfmpeg.kill('SIGKILL'); } catch (e) {}
        currentFfmpeg = null;
      }
      currentResource = null;
    };

    // Cleanup on process exit
    ffmpeg.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[Bot ${botNum}] FFmpeg exited with code ${code}`);
      }
      currentFfmpeg = null;
    });

    return resource;
  };

  const setupPlayer = () => {
    if (player) {
      try { player.stop(true); } catch (e) {}
      player.removeAllListeners();
    }
    player = createAudioPlayer();
    
    player.on('error', err => {
      console.error(`[Bot ${botNum}] Player error:`, err.message);
      if (!stopRequested) {
        cleanupFfmpeg();
        setTimeout(() => playTrack(), 1000);
      }
    });
    
    player.on('stateChange', (oldState, newState) => {
      console.log(`[Bot ${botNum}] Player: ${oldState.status} -> ${newState.status}`);
      if (newState.status === AudioPlayerStatus.Idle && !stopRequested) {
        cleanupFfmpeg();
        setTimeout(() => playTrack(), 100);
      }
    });
    
    connection.subscribe(player);
  };

  const cleanupFfmpeg = () => {
    if (currentFfmpeg) {
      try { currentFfmpeg.kill('SIGKILL'); } catch (e) {}
      currentFfmpeg = null;
    }
    currentResource = null;
  };

  const playTrack = () => {
    if (stopRequested) return;
    if (audioPlayCount >= maxAudioPlays) {
      console.log(`[Bot ${botNum}] 🔥 COMPLETE - ${maxAudioPlays} plays finished`);
      return;
    }
    audioPlayCount++;
    console.log(`[Bot ${botNum}] 🔊 Playing (${audioPlayCount}/${maxAudioPlays})`);

    if (!fs.existsSync(audioPath)) {
      console.error(`[Bot ${botNum}] Audio file not found: ${audioPath}`);
      return;
    }

    const resource = createResource();
    if (!resource) {
      if (!stopRequested) {
        setTimeout(() => playTrack(), 1000);
      }
      return;
    }

    player.play(resource);
  };

  const startPlayback = () => {
    if (!connection) {
      console.error(`[Bot ${botNum}] No connection`);
      return;
    }
    stopRequested = false;
    audioPlayCount = 0;
    setupPlayer();
    playTrack();
  };

  const stopPlayback = () => {
    stopRequested = true;
    audioPlayCount = 0;
    cleanupFfmpeg();
    if (player) {
      try { player.stop(true); } catch (e) {}
      player.removeAllListeners();
      player = null;
    }
  };

  const safeDestroy = (conn) => {
    try {
      if (!conn) return;
      const status = conn.state && conn.state.status;
      if (status && status !== VoiceConnectionStatus.Destroyed) {
        conn.destroy();
      }
    } catch (e) {}
  };

  // ========== VOICE CONNECTION ==========

  const attemptJoinVoiceChannel = async (vc, guild, reply, attempt = 1) => {
    try {
      if (connection) {
        safeDestroy(connection);
        connection = null;
      }

      connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        group: client.user.id
      });

      connection.on('error', err => {
        console.error(`[Bot ${botNum}] Connection error:`, err?.message || err);
        try { safeDestroy(connection); } catch (e) {}
      });
      
      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[Bot ${botNum}] Voice ready`);
      });
      
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log(`[Bot ${botNum}] Disconnected`);
        stopPlayback();
        // Auto-reconnect logic could be added here
      });
      
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log(`[Bot ${botNum}] Destroyed`);
        stopPlayback();
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 25000);
      console.log(`[Bot ${botNum}] Joined ✅`);
      await reply('✅ Joined your voice channel.');
    } catch (err) {
      console.error(`[Bot ${botNum}] Join error (attempt ${attempt}):`, err?.message || err);
      safeDestroy(connection);
      connection = null;
      if (attempt < MAX_JOIN_RETRIES) {
        const retryDelay = 1500 * attempt;
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
    if (!guild || !member) return reply('Command failed: missing guild or member data.');

    const isAdmin = member.permissions.has('Administrator');
    const hasAllowedRole = allowedRoleIds.length > 0 &&
      allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

    if (!isAdmin && !hasAllowedRole) {
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
      if (!connection) return reply('Bot is not in a voice channel.');
      if (!fs.existsSync(audioPath)) {
        return reply(`Audio file not found for bot ${botNum}.`);
      }
      const startAt = getSharedChstStartTime();
      const delay = Math.max(100, startAt - Date.now());
      setTimeout(() => {
        try { startPlayback(); } catch (err) {
          console.error(`[Bot ${botNum}] startPlayback error:`, err?.message || err);
        }
      }, delay);
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
        const connState = connection ? (connection.state && connection.state.status) : 'not connected';
        const playerState = player ? (player.state && player.state.status) : 'no player';
        const msg = `Connection: ${connState}\nPlayer: ${playerState}`;
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
      if (client.application && client.application.commands && typeof client.application.commands.set === 'function') {
        await client.application.commands.set(slashCommands);
        console.log(`[Bot ${botNum}] Registered global slash commands`);
      } else {
        const guilds = await client.guilds.fetch();
        for (const [guildId, guild] of guilds) {
          if (guild && guild.commands && typeof guild.commands.set === 'function') {
            await guild.commands.set(slashCommands);
          }
        }
        console.log(`[Bot ${botNum}] Registered slash commands in ${guilds.size} guild(s)`);
      }
    } catch (err) {
      console.error(`[Bot ${botNum}] Slash command registration failed: ${err.message}`);
    }

    // Auto-join and auto-start playback when environment variables are set.
    try {
      const envChannel = process.env[`AUTO_JOIN_CHANNEL_ID_${botNum}`] || process.env.AUTO_JOIN_CHANNEL_ID;
      if (envChannel) {
        try {
          const targetChannel = await client.channels.fetch(envChannel).catch(() => null);
          if (!targetChannel || !targetChannel.isVoiceBased && !targetChannel.isStageBased) {
            console.warn(`[Bot ${botNum}] AUTO_JOIN: channel ${envChannel} not found or not a voice channel`);
          } else {
            connection = joinVoiceChannel({
              channelId: targetChannel.id,
              guildId: targetChannel.guild.id,
              adapterCreator: targetChannel.guild.voiceAdapterCreator,
              selfDeaf: true,
              group: client.user.id
            });
            connection.on('error', err => {
              console.error(`[Bot ${botNum}] AUTO VOICE CONNECTION ERROR:`, err?.message || err);
              try { safeDestroy(connection); } catch (e) {}
            });
            console.log(`[Bot ${botNum}] AUTO JOINED channel ${envChannel}`);
            try {
              await entersState(connection, VoiceConnectionStatus.Ready, 15000);
              console.log(`[Bot ${botNum}] AUTO VOICE READY`);
              startPlayback();
            } catch (err) {
              console.error(`[Bot ${botNum}] AUTO startPlayback failed:`, err?.message || err);
            }
          }
        } catch (e) {
          console.error(`[Bot ${botNum}] AUTO_JOIN error:`, e.message);
        }
      }
    } catch (e) {}
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.bot) return;

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