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
const ffmpegPath = require('ffmpeg-static');

// Ensure ffmpeg is accessible for prism-media transcoding
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
  console.log(`[System] FFMPEG_PATH set to ${ffmpegPath}`);
} else {
  console.warn('[System] ffmpeg-static not found! Audio transcoding may fail.');
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
  let currentFfmpeg = null;
  let currentResource = null;

  // Use MP3 files (tracked by git, deployed on Render)
  const audioPath = path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${botNum}.mp3`);

  // ========== AUDIO SYSTEM ==========
  
  // Kill any running ffmpeg process
  const killFfmpeg = () => {
    if (currentFfmpeg) {
      try { currentFfmpeg.kill('SIGKILL'); } catch (e) {}
      currentFfmpeg = null;
    }
  };

  // Create an optimized audio resource using ffmpeg
  // Decodes MP3 → encodes to Opus directly in a single process
  const createOptimizedResource = () => {
    if (!fs.existsSync(audioPath)) {
      console.error(`[Bot ${botNum}] Audio file NOT FOUND: ${audioPath}`);
      return null;
    }

    killFfmpeg();

    console.log(`[Bot ${botNum}] Starting ffmpeg...`);

    // FIXED: Use only standard ffmpeg options that are guaranteed to work
    // across all ffmpeg-static builds.
    //
    // Removed non-standard options that caused errors:
    // - '-apply_fec'     → Unrecognized option (libopus AVOption, not ffmpeg option)
    // - '-frame_duration' → May not be available on all builds
    // - '-application'    → May not be available on all builds
    // - '-compression_level' → May not be available on all builds
    // - '-vbr off'        → Already default for libopus
    //
    // Using only: input file → libopus encoder → Ogg container → stdout
    const ffmpeg = spawn(ffmpegPath, [
      '-i', audioPath,
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      '-flush_packets', '1',
      '-fflags', '+nobuffer+fastseek+flush_packets',
      '-flags', '+global_header',
      '-avoid_negative_ts', 'make_zero',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    currentFfmpeg = ffmpeg;

    // Log ffmpeg stderr for debugging
    let stderrData = '';
    ffmpeg.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Bot ${botNum}] FFmpeg error:`, err.message);
      killFfmpeg();
    });

    ffmpeg.on('exit', (code, signal) => {
      console.log(`[Bot ${botNum}] FFmpeg exit: code=${code}, signal=${signal}`);
      if (code !== 0) {
        console.error(`[Bot ${botNum}] FFmpeg stderr: ${stderrData.slice(-500)}`);
      }
      if (currentFfmpeg === ffmpeg) currentFfmpeg = null;
    });

    // FIXED: Use OggOpus stream type (most compatible with @discordjs/voice)
    // StreamType.Opus expects raw Opus packets without container
    // StreamType.OggOpus expects Ogg container with Opus (more reliable)
    let resource;
    try {
      resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.OggOpus,
        inlineVolume: true
      });
    } catch (err) {
      console.error(`[Bot ${botNum}] createAudioResource failed:`, err.message);
      killFfmpeg();
      return null;
    }

    // FIXED: Verify resource has required methods before attaching listeners
    if (!resource || typeof resource.playStream === 'undefined' && typeof resource.volume === 'undefined') {
      console.error(`[Bot ${botNum}] Invalid AudioResource returned`);
      killFfmpeg();
      return null;
    }

    currentResource = resource;

    // FIXED: Use AudioPlayer events instead of resource events
    // AudioResource in @discordjs/voice may not emit 'end'/'error' events directly
    // The AudioPlayer's stateChange event handles playback completion

    return resource;
  };

  const setupPlayer = () => {
    if (player) {
      try { player.stop(true); } catch (e) {}
      player.removeAllListeners();
      player = null;
    }
    
    player = createAudioPlayer();
    
    player.on('error', err => {
      console.error(`[Bot ${botNum}] Player error:`, err.message);
      killFfmpeg();
      if (!stopRequested) {
        setTimeout(() => playTrack(), 1000);
      }
    });
    
    player.on('stateChange', (oldState, newState) => {
      console.log(`[Bot ${botNum}] Player: ${oldState.status} -> ${newState.status}`);
      if (newState.status === AudioPlayerStatus.Idle && !stopRequested) {
        console.log(`[Bot ${botNum}] Player idle - cleaning up ffmpeg`);
        killFfmpeg();
        if (audioPlayCount < maxAudioPlays) {
          setTimeout(() => playTrack(), 100);
        } else {
          console.log(`[Bot ${botNum}] 🔥 COMPLETE - ${maxAudioPlays} plays finished`);
        }
      }
      if (newState.status === AudioPlayerStatus.Playing) {
        console.log(`[Bot ${botNum}] Playback started successfully`);
      }
      if (newState.status === AudioPlayerStatus.Buffering) {
        console.log(`[Bot ${botNum}] Buffering audio...`);
      }
    });
    
    if (connection) {
      connection.subscribe(player);
    }
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
      console.error(`[Bot ${botNum}] Audio file NOT FOUND: ${audioPath}`);
      return;
    }

    const resource = createOptimizedResource();
    if (!resource) {
      if (!stopRequested) {
        setTimeout(() => playTrack(), 1000);
      }
      return;
    }

    if (player) {
      player.play(resource);
    } else {
      console.error(`[Bot ${botNum}] No player available`);
    }
  };

  const startPlayback = () => {
    if (!connection) {
      console.error(`[Bot ${botNum}] startPlayback: No connection`);
      return;
    }
    const connStatus = connection.state?.status;
    console.log(`[Bot ${botNum}] startPlayback: connection status = ${connStatus}`);
    
    stopRequested = false;
    audioPlayCount = 0;
    setupPlayer();
    playTrack();
  };

  const stopPlayback = () => {
    console.log(`[Bot ${botNum}] stopPlayback called`);
    stopRequested = true;
    audioPlayCount = 0;
    if (player) {
      try { player.stop(true); } catch (e) {}
      player.removeAllListeners();
      player = null;
    }
  };

  const safeDestroy = (conn) => {
    try {
      if (!conn) return;
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

      connection.on('error', err => {
        console.error(`[Bot ${botNum}] Connection error:`, err?.message || err);
      });
      
      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[Bot ${botNum}] Voice ready`);
      });
      
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log(`[Bot ${botNum}] Disconnected`);
        stopPlayback();
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
        console.log(`[Bot ${botNum}] bkst failed: no connection`);
        return reply('Bot is not in a voice channel.');
      }
      console.log(`[Bot ${botNum}] Connection status: ${connection.state?.status}`);
      
      console.log(`[Bot ${botNum}] bkst: checking audio file...`);
      if (!fs.existsSync(audioPath)) {
        console.error(`[Bot ${botNum}] Audio file not found: ${audioPath}`);
        return reply(`Audio file ${botNum} not found.`);
      }
      console.log(`[Bot ${botNum}] Audio file OK: ${audioPath}`);

      const startAt = getSharedChstStartTime();
      const delay = Math.max(100, startAt - Date.now());
      console.log(`[Bot ${botNum}] Scheduling playback in ${delay}ms`);
      setTimeout(() => {
        console.log(`[Bot ${botNum}] Starting playback now...`);
        try { 
          startPlayback(); 
        } catch (err) {
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
        const connState = connection ? (connection.state?.status) : 'not connected';
        const playerState = player ? (player.state?.status) : 'no player';
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

    // Auto-join and auto-start playback when environment variables are set.
    try {
      const envChannel = process.env[`AUTO_JOIN_CHANNEL_ID_${botNum}`] || process.env.AUTO_JOIN_CHANNEL_ID;
      if (envChannel) {
        try {
          const targetChannel = await client.channels.fetch(envChannel).catch(() => null);
          if (!targetChannel || !targetChannel.isVoiceBased && !targetChannel.isStageBased) {
            console.warn(`[Bot ${botNum}] AUTO_JOIN: channel ${envChannel} not found or not a voice channel`);
          } else {
            console.log(`[Bot ${botNum}] AUTO_JOIN: joining channel ${envChannel}`);
            connection = joinVoiceChannel({
              channelId: targetChannel.id,
              guildId: targetChannel.guild.id,
              adapterCreator: targetChannel.guild.voiceAdapterCreator,
              selfDeaf: true,
              group: client.user.id
            });
            connection.on('error', err => {
              console.error(`[Bot ${botNum}] AUTO VOICE CONNECTION ERROR:`, err?.message || err);
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