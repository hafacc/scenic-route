#!/usr/bin/env bash
# Records what the runner can reach before the day's read (`update-sheds` hangs on Socrata only from runners): its egress address, then client and token varied one at a time; observational, `continue-on-error`, ~5 s healthy, ~75 s capped.
set -u

HOST=data.cityofnewyork.us
# The smallest read the failing dataset can answer, so a hang is the connection and not the query.
PROBE="https://$HOST/resource/5zhs-2jue.json?%24select=bin&%24limit=1"
FORMAT='  http=%{http_code} ip=%{remote_ip} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n'

# Runners draw a new egress address daily; if reachability is keyed to it, this correlates with success.
echo "egress: $(curl -s --max-time 10 https://api.ipify.org || echo unknown)"
# `dig +short` prints the CNAME chain too, so keep only the lines that look like addresses.
addresses() {
  dig +short "$HOST" A | grep -E '^[0-9]+(\.[0-9]+){3}$'
}

echo "resolver:"
echo "  A:    $(addresses | tr '\n' ' ')"
echo "  AAAA: $(dig +short "$HOST" AAAA | tr '\n' ' ')"
echo "  CNAME: $(dig +short "$HOST" CNAME | tr '\n' ' ')"

# No `tcp` means a drop below HTTP; `tls` without `ttfb` means something reads the ClientHello or SNI.
echo "probe (no token):"
curl -s -o /dev/null --max-time 15 -w "$FORMAT" "$PROBE"
echo "probe (token):"
curl -s -o /dev/null --max-time 15 -H "X-App-Token: ${SOCRATA_APP_TOKEN:-}" -w "$FORMAT" "$PROBE"

# Per address: the host is a bare AWS load balancer with three targets, so one hanging means one bad target.
for address in $(addresses); do
  echo "probe (pinned $address):"
  curl -s -o /dev/null --max-time 15 --resolve "$HOST:443:$address" -w "$FORMAT" "$PROBE"
done

# Whether AWS us-east-1 is reachable at all; not another Socrata host, since data.sf.gov shares the load balancer.
echo "control (s3 us-east-1):"
curl -s -o /dev/null --max-time 15 -w "$FORMAT" https://s3.amazonaws.com

exit 0
