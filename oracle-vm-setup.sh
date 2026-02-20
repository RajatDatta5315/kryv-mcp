#!/bin/bash
# ============================================================
# KRYV-MCP Oracle VM Setup + Crash Prevention
# File: oracle-vm-setup.sh
# Run once on your Oracle VM: bash oracle-vm-setup.sh
# ============================================================

set -e
echo "=== KRYV-MCP Oracle VM Setup ==="

# ── 1. System update ──
sudo apt update -y && sudo apt upgrade -y
sudo apt install -y python3-pip git curl wget htop

# ── 2. Install Python deps ──
pip3 install requests schedule psutil --break-system-packages

# ── 3. Clone repo ──
cd /home/ubuntu
git clone https://github.com/rajatdatta90000/kryv-mcp.git || git -C kryv-mcp pull
cd kryv-mcp

# ── 4. Create environment file ──
cat > /home/ubuntu/kryv-mcp/.env << 'ENVFILE'
KRYV_SERVER=https://kryv-mcp.rajatdatta90000.workers.dev
KRYV_CLIENT_ID=your-admin-client-id-here
KRYV_PRIVACY=false
ENVFILE
echo "→ .env created. Edit: nano /home/ubuntu/kryv-mcp/.env"

# ── 5. Create systemd service (crash auto-restart) ──
sudo tee /etc/systemd/system/kryv-agent.service > /dev/null << 'SERVICE'
[Unit]
Description=KRYV-MCP Context Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/kryv-mcp
EnvironmentFile=/home/ubuntu/kryv-mcp/.env
ExecStart=/usr/bin/python3 oracle-agent.py
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kryv-agent

[Install]
WantedBy=multi-user.target
SERVICE

# ── 6. Create watchdog (extra layer — checks every 5 min) ──
sudo tee /usr/local/bin/kryv-watchdog.sh > /dev/null << 'WATCHDOG'
#!/bin/bash
SERVICE="kryv-agent"
if ! systemctl is-active --quiet $SERVICE; then
  echo "[$(date)] $SERVICE was down. Restarting..." >> /var/log/kryv-watchdog.log
  systemctl restart $SERVICE
  echo "[$(date)] Restarted." >> /var/log/kryv-watchdog.log
fi
WATCHDOG
sudo chmod +x /usr/local/bin/kryv-watchdog.sh

# ── 7. Add watchdog to cron (every 5 minutes) ──
(crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/kryv-watchdog.sh") | crontab -

# ── 8. Auto-update from GitHub (daily at 3am) ──
sudo tee /usr/local/bin/kryv-update.sh > /dev/null << 'UPDATE'
#!/bin/bash
cd /home/ubuntu/kryv-mcp
git pull origin main >> /var/log/kryv-update.log 2>&1
systemctl restart kryv-agent >> /var/log/kryv-update.log 2>&1
echo "[$(date)] Updated and restarted." >> /var/log/kryv-update.log
UPDATE
sudo chmod +x /usr/local/bin/kryv-update.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /usr/local/bin/kryv-update.sh") | crontab -

# ── 9. Enable and start ──
sudo systemctl daemon-reload
sudo systemctl enable kryv-agent
sudo systemctl start kryv-agent

echo ""
echo "✓ KRYV-MCP Agent installed with crash prevention"
echo ""
echo "Commands:"
echo "  Status:   sudo systemctl status kryv-agent"
echo "  Logs:     sudo journalctl -u kryv-agent -f"
echo "  Restart:  sudo systemctl restart kryv-agent"
echo "  Watchdog: cat /var/log/kryv-watchdog.log"
echo ""
echo "Edit your config:"
echo "  nano /home/ubuntu/kryv-mcp/.env"
echo "  sudo systemctl restart kryv-agent"
