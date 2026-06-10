#!/bin/bash
# Insta Automation - EC2 / Linux Server Deployment Script

set -e

echo "Starting deployment setup for Insta Automation..."

# 1. Update system packages
sudo apt-get update && sudo apt-get upgrade -y

# 2. Install Node.js (Version 20.x)
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. Install PM2 globally
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    sudo npm install pm2 -g
fi

# 4. Navigate to the project directory (assuming script is run from project root)
cd "$(dirname "$0")/.."

# 5. Install project dependencies
echo "Installing project dependencies..."
npm install

# 6. Start the server with PM2
echo "Starting the application with PM2..."
pm2 start src/server.js --name "insta-automation" --time

# 7. Configure PM2 to start on boot
echo "Configuring PM2 startup script..."
pm2 save
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME

echo ""
echo "=========================================================="
echo "Deployment Complete!"
echo "Your Insta Automation server is now running in the background."
echo "You can view the logs at any time by running: pm2 logs insta-automation"
echo "To restart the server after code changes, run: pm2 restart insta-automation"
echo "=========================================================="
