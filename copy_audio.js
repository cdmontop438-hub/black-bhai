const fs = require('fs');
const path = require('path');

const sourceFile = 'V.2 DARK BOOGEYMAN 4LUVONTOP (1)_compressed.mp3';

if (!fs.existsSync(sourceFile)) {
  console.error('Source file not found:', sourceFile);
  process.exit(1);
}

for (let i = 1; i <= 10; i++) {
  const destFile = `audio${i}.mp3`;
  fs.copyFileSync(sourceFile, destFile);
  console.log(`Created: ${destFile}`);
}

console.log('✅ All 10 audio files created successfully');