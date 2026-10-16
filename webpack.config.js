const path = require('path');

module.exports = (env, argv) => ({
  target: 'node22', // Node.js 22.13+ (нужен встроенный node:sqlite и динамический import)
  mode: argv.mode || 'production',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bot.js',
    clean: true,
  },
  // встроенный модуль Node.js — подключается во время выполнения
  externals: [
    { 'node:sqlite': 'commonjs node:sqlite' },
    // mtcute (MTProto) — ESM-пакеты с wasm, подключаются динамически только при включённом прокси
    ({ request }, callback) =>
      /^@(mtcute|fuman)\//.test(request) ? callback(null, `import ${request}`) : callback(),
  ],
  node: {
    __dirname: false,
    __filename: false,
  },
  optimization: {
    minimize: false,
  },
  devtool: argv.mode === 'development' ? 'source-map' : false,
  stats: 'minimal',
});
