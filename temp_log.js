const { execSync } = require('child_process');
const fs = require('fs');

try {
  const stdout = execSync('git log -p -n 5 -- routes/customer.js', { encoding: 'utf-8' });
  fs.writeFileSync('git_log_output.txt', stdout);
  console.log("Success");
} catch (e) {
  fs.writeFileSync('git_log_output.txt', "Error: " + e.message);
  console.error(e);
}
