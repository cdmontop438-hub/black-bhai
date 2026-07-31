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

const MAX_JOIN_RETRIES = parseInt(process.env.MAX_JOIN_RETRIES, 10) || 3;
const JOIN_STAGGER_MS = parseInt(process.env.JOIN_STAGGER_MS, 10) || 300;   // ⚡ 300ms smooth stagger (prevents connection aborts)
const JOIN_CONCURRENCY = parseInt(process.env.JOIN_CONCURRENCY, 10) || 3;   // ⚡ 3 parallel joins (prevents UDP port congestion)
const PCM_CONVERT_CONCURRENCY = parseInt(process.env.PCM_CONVERT_CONCURRENCY, 10) || 2;
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

// Heavy Saturation & Boost filter chain
// Stage 1: volume=25dB   — drive input hard into saturation
// Stage 2: acrusher      — crunchy saturation / distortion ("erachal" effect)
// Stage 3: treble        — high-frequency bite
// Stage 4: volume=10dB   — extra boost
// Stage 5: alimiter      — cap peaks at 0.99 so audio NEVER overflows into silence
const DISTORTION_FILTER = [
  'volume=25dB',
  'acrusher=level_in=1:level_out=1:bits=8:mode=log:aa=1',
  'treble=g=12:f=4000',
  'volume=10dB',
  'alimiter=limit=0.99:level=true'
].join(',');

const convertAudioFile = async (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const conv = spawn(ffmpegPath, [
      '-y', '-i', inputPath,
      '-af', DISTORTION_FILTER,
      '-ar', '48000', '-ac', '2', '-f', 's16le',
      outputPath
    ]);
    conv.stderr.on('data', () => {});
    conv.on('error', err => reject(err));
    conv.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg convert failed with code ${code}`)));
  });
};

const ensurePcmFile = async (audioPath) => {
  const pcmPath = audioPath.replace(/\.mp3$/i, '.pcm');
  // ✅ BUG FIX: just return existing boosted PCM — do NOT delete/reconvert every play!
  // Startup preconvertMissingAudioFiles() already handles the one-time re-bake.
  if (fs.existsSync(pcmPath)) {
    return pcmPath;
  }
  // Fallback: convert if somehow missing
  await convertAudioFile(audioPath, pcmPath);
  return pcmPath;
};

const preconvertMissingAudioFiles = async () => {
  const audioFiles = [];
  for (let i = 1; i <= 10; i += 1) {
    audioFiles.push(`BOOGEYMAN.KX4.DARK.AUDIO.${i}.mp3`);
  }

  console.log(`[PCM] Preconverting up to ${audioFiles.length} missing PCM files with concurrency ${PCM_CONVERT_CONCURRENCY}...`);

  const tasks = audioFiles.map(file => async () => {
    const audioPath = path.join(__dirname, file);
    const pcmPath = audioPath.replace(/\.mp3$/i, '.pcm');
    if (!fs.existsSync(audioPath)) {
      console.log(`[PCM] SKIP missing audio file ${file}`);
      return;
    }
    // Always re-bake PCM with boosted volume
    if (fs.existsSync(pcmPath)) {
      try { fs.unlinkSync(pcmPath); } catch (e) {}
    }
    try {
      await convertAudioFile(audioPath, pcmPath);
      console.log(`[PCM] Converted ${file}`);
    } catch (err) {
      console.error(`[PCM] Failed to convert ${file}:`, err.message || err);
    }
  });

  const active = [];
  for (const task of tasks) {
    while (active.length >= PCM_CONVERT_CONCURRENCY) {
      await Promise.race(active);
      for (let i = active.length - 1; i >= 0; i -= 1) {
        if (active[i].isFulfilled || active[i].isRejected) {
          active.splice(i, 1);
        }
      }
    }
    const promise = task();
    promise.isFulfilled = false;
    promise.isRejected = false;
    promise.then(() => { promise.isFulfilled = true; }, () => { promise.isRejected = true; });
    active.push(promise);
  }
  await Promise.allSettled(active);
  console.log('[PCM] Preconversion complete.');
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

void preconvertMissingAudioFiles().catch(err => console.error('[PCM] Preconversion error:', err));

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
  let currentFfmpegProcess = null;
  let stopRequested = false;
  let isJoining = false;
  let audioPlayCount = 0;
  let maxAudioPlays = 10;

  // Reusable playback starter so we can trigger playback from commands or auto-join
  const startPlayback = async () => {
    if (!connection) {
      console.error(`[Bot ${botNum}] startPlayback called without a voice connection`);
      return;
    }

    const audioPath = path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${botNum}.mp3`);

    stopRequested = false;
    audioPlayCount = 0;

    const playOnce = async () => {
      if (stopRequested) return;
      if (audioPlayCount >= maxAudioPlays) {
        console.log(`[Bot ${botNum}] 🔥 BOOGEYMAN COMPLETE - ${maxAudioPlays} plays finished`);
        return;
      }
      audioPlayCount++;
      console.log(`[Bot ${botNum}] 🔊 BOOGEYMAN PLAYING (${audioPlayCount}/${maxAudioPlays}) -> ${audioPath}`);

      let resource;
      try {
        const pcmPath = await ensurePcmFile(audioPath);
        // ⚡ 128KB stream buffer prevents audio stuttering ("strucking") on cloud hosts
        const stream = fs.createReadStream(pcmPath, { highWaterMark: 128 * 1024 });
        resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
      } catch (err) {
        console.warn(`[Bot ${botNum}] PCM fallback to ffmpeg stream:`, err.message || err);
        // Same distortion chain applied in live stream fallback
        const ffmpegArgs = [
          '-i', audioPath,
          '-af', DISTORTION_FILTER,
          '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'
        ];
        if (currentFfmpegProcess) {
          currentFfmpegProcess.kill();
          currentFfmpegProcess = null;
        }
        currentFfmpegProcess = spawn(ffmpegPath, ffmpegArgs);
        resource = createAudioResource(currentFfmpegProcess.stdout, { inputType: StreamType.Raw, inlineVolume: true });
        currentFfmpegProcess.stderr.on('data', chunk => console.error(`[Bot ${botNum}] FFMPEG: ${chunk.toString().trim()}`));
        currentFfmpegProcess.on('error', err => console.error(`[Bot ${botNum}] FFMPEG PROCESS ERROR:`, err.message));
      }

      if (resource.volume) resource.volume.setVolume(1.0);

      if (!player) {
        player = createAudioPlayer();
        player.on('error', err => console.error(`[Bot ${botNum}] AUDIO PLAYER ERROR:`, err.message));
        player.on('stateChange', (o, n) => {
          if (n.status === AudioPlayerStatus.Idle && !stopRequested && audioPlayCount < maxAudioPlays) {
            setTimeout(() => {
              playOnce().catch(err => console.error(`[Bot ${botNum}] playOnce error:`, err?.message || err));
            }, 100);
          }
        });
      }

      player.play(resource);
      const subscription = connection.subscribe(player);
      if (!subscription) console.error(`[Bot ${botNum}] FAILED TO SUBSCRIBE AUDIO PLAYER`);
    };

    await playOnce();
  };

  const safeDestroy = (conn) => {
    try {
      if (!conn) return;
      const status = conn.state && conn.state.status;
      if (status && status !== VoiceConnectionStatus.Destroyed) {
        conn.destroy();
      }
    } catch (e) {
      // ignore double-destroy or other race errors
    }
  };

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
        console.error(`[Bot ${botNum}] VOICE CONNECTION ERROR:`, err?.message || err);
        try { safeDestroy(connection); } catch (e) {}
      });
      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[Bot ${botNum}] VOICE READY`);
      });
      connection.on(VoiceConnectionStatus.Disconnected, (oldState, newState) => {
        console.log(`[Bot ${botNum}] VOICE DISCONNECTED ${oldState.status} -> ${newState.status}`);
      });
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log(`[Bot ${botNum}] VOICE DESTROYED`);
      });
      connection.on('stateChange', (oldState, newState) => {
        console.log(`[Bot ${botNum}] VOICE STATE: ${oldState.status} -> ${newState.status}`);
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 25000); // ⚡ 25s ready wait for cloud servers
      console.log(`[Bot ${botNum}] JOINED ✅`);
      await reply('✅ Joined your voice channel.');
    } catch (err) {
      console.error(`[Bot ${botNum}] JOIN ERROR attempt ${attempt}:`, err?.message || err);
      safeDestroy(connection);
      connection = null;
      if (attempt < MAX_JOIN_RETRIES) {
        const retryDelay = 1500 * attempt;
        console.log(`[Bot ${botNum}] Retrying join in ${retryDelay}ms (attempt ${attempt + 1}/${MAX_JOIN_RETRIES})`);
        await sleep(retryDelay);
        return attemptJoinVoiceChannel(vc, guild, reply, attempt + 1);
      }
      await reply('❌ Failed to join voice channel after multiple attempts.');
    } finally {
      if (attempt === 1) {
        isJoining = false;
      }
    }
  };

  // Parse allowed role IDs from env (comma-separated)
  const allowedRoleIds = (process.env.ALLOWED_ROLE_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);

  const handleBotCommand = async (commandName, reply, guild, member) => {
    if (!guild || !member) return reply('Command failed: missing guild or member data.');

    // Access check: allow Administrators OR members with at least one allowed role
    const isAdmin = member.permissions.has('Administrator');
    const hasAllowedRole = allowedRoleIds.length > 0 &&
      allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

    if (!isAdmin && !hasAllowedRole) {
      if (allowedRoleIds.length === 0) {
        return reply('❌ You need **Administrator** permissions to use this command.');
      }
      // Build role mention list for a helpful error message
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

      // Use bot-specific audio file (allow using pre-converted .pcm if .mp3 is missing)
      const botAudio = path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${botNum}.mp3`);
      const botPcm = botAudio.replace(/\.mp3$/i, '.pcm');
      if (!fs.existsSync(botAudio) && !fs.existsSync(botPcm)) {
        return reply(`BOOGEYMAN audio file ${botNum} not found (mp3 or pcm missing).`);
      }

      // Align start time across bots for synchronized playback
      const startAt = getSharedChstStartTime();
      const delay = Math.max(100, startAt - Date.now());
      setTimeout(() => {
        startPlayback().catch(err => console.error(`[Bot ${botNum}] startPlayback error:`, err?.message || err));
      }, delay);

      return reply('🔥 BOOGEYMAN 10x REPEAT ACTIVATED (Boosted Audio)');
    }

    if (commandName === 'bksp') {
      stopRequested = true;
      audioPlayCount = 0;
      if (player) {
        player.stop(true);
      }
      if (currentFfmpegProcess) {
        currentFfmpegProcess.kill();
        currentFfmpegProcess = null;
      }
      return reply('✅ Audio stopped.');
    }

    if (commandName === 'bklv') {
      safeDestroy(connection);
      connection = null;
      return reply('✅ Left voice channel.');
    }

    if (commandName === 'status') {
      try {
        const connState = connection ? (connection.state && connection.state.status) : 'not connected';
        const channelId = connection && connection.joinConfig ? connection.joinConfig.channelId : (connection && connection.joining ? connection.joining.channelId : 'none');
        const playerState = player ? (player.state && player.state.status) : 'no player';
        const ffmpegRunning = currentFfmpegProcess ? true : false;
        const msg = `Connection: ${connState}\nChannel: ${channelId}\nPlayer: ${playerState}\nFFmpeg running: ${ffmpegRunning}`;
        await reply(`


${msg}
`);
      } catch (e) {
        console.error(`[Bot ${botNum}] STATUS CMD ERROR:`, e.message);
        await reply('Failed to retrieve status.');
      }
      return;
    }

    return reply('Unknown command.');
  };

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const content = message.content.trim().toLowerCase();
    if (!['!bkva', '!bkst', '!bksp', '!bklv', '!status'].includes(content)) return;

    // ⚡ Only Bot 1 sends text chat responses to prevent 10x spam & Missing Permission errors
    const reply = async text => {
      if (botNum !== 1) return;
      try {
        await message.reply(text).catch(() => {});
      } catch (err) {
        // ignore reply error
      }
    };

    await handleBotCommand(content.slice(1), reply, message.guild, message.member);
  });

  client.on('ready', async () => {
    console.log(`[Bot ${botNum}] ONLINE ✅`);

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
      console.error(`[Bot ${botNum}] SLASH COMMAND REGISTRATION FAILED: ${err.message}`);
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
            // join
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
              await startPlayback();
            } catch (err) {
              console.error(`[Bot ${botNum}] AUTO startPlayback failed:`, err?.message || err);
            }
          }
        } catch (e) {
          console.error(`[Bot ${botNum}] AUTO_JOIN error:`, e.message);
        }
      }
    } catch (e) {
      // ignore
    }
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
