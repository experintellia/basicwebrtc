// Starts server.js in this test process, by default on a random port; returns its URL.
// ponytail: in-process, the runner exits via --test-force-exit
module.exports = env => {
  Object.assign(process.env, { listen_port: 3100 + Math.floor(Math.random() * 1000), listen_ip: '127.0.0.1' }, env);
  require('../server.js');
  return 'http://127.0.0.1:' + process.env.listen_port;
};
