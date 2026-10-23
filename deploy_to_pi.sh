#!/bin/sh
# Copy Perception to the Pi, set up its Python environment, and (re)start it
# as a service.  Run from this folder:  sh deploy_to_pi.sh
# modules.json on the Pi is kept if it already exists, so edits made there
# survive a redeploy; delete it on the Pi to take this copy's.
set -e
PI=${PI:-raspberrypi}
DEST=/home/tom/Perception

ssh "$PI" "mkdir -p $DEST/static"
scp -q server.py requirements.txt perception.service "$PI:$DEST/"
scp -q static/* "$PI:$DEST/static/"
ssh "$PI" "[ -f $DEST/modules.json ]" || scp -q modules.json "$PI:$DEST/"

ssh "$PI" "
  set -e
  cd $DEST
  [ -d venv ] || python3 -m venv venv
  venv/bin/pip install -q -r requirements.txt
  sudo cp perception.service /etc/systemd/system/perception.service
  sudo systemctl daemon-reload
  sudo systemctl enable -q perception
  sudo systemctl restart perception
  sleep 2
  systemctl is-active perception
"
echo "Perception is at http://$PI:8300"
