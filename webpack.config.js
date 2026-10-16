const path = require('path');

module.exports = (env, argv) => ({
  target: 'node',
  mode: argv.mode || 'production',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bot.js',
    clean: true,
  },
  // встроенный модуль Node.js — подключается во время выполнения
  externals: {
    'node:sqlite': 'commonjs node:sqlite',
  },
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
