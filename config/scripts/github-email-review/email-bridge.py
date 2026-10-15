"""Outlook webhook events via Composio, dispatched into one Orca automation.

No scheduled mailbox or GitHub polling. Network reads occur on setup, reconnect,
or receipt of a notification. Windows Task Scheduler starts this listener at login.
"""
import argparse
import contextlib
from datetime import datetime
import hashlib
import html
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from event_protocol import Chunks, decoded, message_id as event_message_id

ROOT = Path(__file__).resolve().parent
EVENT_NAME = r'Local\OrcaAgencyGitHubEmailQueue'
RUN_SIGNAL = threading.Event()
SELF = 'brooksgolden'
REPOS = {'stablyai/orca', 'brooksgolden/Orca-Agency'}


class IgnoreNotification(Exception):
    """Only an explicitly deleted notification or a verified other sender."""


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def read(path, fallback=None):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else fallback


def write(path, value):
    temp = path.with_name(path.name + f'.{uuid.uuid4().hex}.tmp')
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(temp, path)


@contextlib.contextmanager
def lock(name, timeout=120):
    import msvcrt
    with (ROOT / name).open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        deadline = time.monotonic() + timeout
        while True:
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'Lock busy: {name}') from None
                time.sleep(0.1)
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def state():
    return read(ROOT / 'state.json', {'items': {}, 'activeRun': None})


def command(argv, timeout=45, input_text=None):
    env = dict(os.environ, GH_PROMPT_DISABLED='1', GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never')
    result = subprocess.run(argv, input=input_text, capture_output=True, encoding='utf-8',
                            cwd=ROOT, env=env, timeout=timeout,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        # Do not log remote bodies, credentials or arbitrary command arguments.
        raise RuntimeError(f'{Path(argv[0]).name} failed with exit {result.returncode}')
    return result.stdout.strip()


def gh(route, method='GET', body=None):
    argv = ['gh', 'api', '--method', method, route]
    if body is not None:
        argv += ['--input', '-']
    return json.loads(command(argv, input_text=json.dumps(body) if body is not None else None))


def composio_api(route, method='GET', body=None):
    auth = read(Path.home() / '.composio/user_data.json')
    headers = read(ROOT / 'composio-cli-headers.json').copy()
    headers['x-user-api-key'] = auth['api_key']
    headers['Content-Type'] = 'application/json'
    # Use the CLI's current consumer context, not a different developer project.
    request = urllib.request.Request(auth['base_url'] + '/api/v3.1/' + route,
                                     headers=headers, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Composio {method} failed: HTTP {error.code}') from None


def fetch_email(message_id):
    url = ('https://graph.microsoft.com/v1.0/me/messages/' + urllib.parse.quote(message_id, safe='')
           + '?$select=id,subject,body,from,internetMessageId,receivedDateTime')
    message = json.loads(command([str(Path.home() / '.composio/composio.exe'), 'proxy', url,
                                  '--toolkit', 'outlook']))
    if 'error' in message:
        if message['error'].get('code') in ('ErrorItemNotFound', 'Request_ResourceNotFound'):
            raise IgnoreNotification('Notification no longer exists')
        raise RuntimeError('Outlook notification retrieval failed')
    sender = message.get('from', {}).get('emailAddress', {}).get('address')
    if not isinstance(sender, str) or not sender:
        raise RuntimeError('Outlook returned invalid notification metadata')
    if sender.lower() != 'notifications@github.com':
        raise IgnoreNotification('Notification sender does not match GitHub')
    return message


def target_from_email(message):
    text = html.unescape(urllib.parse.unquote(message.get('body', {}).get('content', '')))
    subject = message.get('subject', '').lower()
    if '[brooksgolden/orca-agency]' in subject and 'run failed:' in subject:
        runs = set(re.findall(r'https://github\.com/brooksgolden/Orca-Agency/actions/runs/(\d+)', text, re.I))
        if len(runs) == 1:
            identifier = int(next(iter(runs)))
            return {'repo': 'brooksgolden/Orca-Agency', 'number': identifier,
                    'kind': 'workflow', 'commentId': None,
                    'url': f'https://github.com/brooksgolden/Orca-Agency/actions/runs/{identifier}'}
    targets = []
    pattern = r'https://github\.com/([^/\s<>"\']+)/([^/\s<>"\']+)/(issues|pull)/(\d+)(?:#(issuecomment-|discussion_r|pullrequestreview-)(\d+))?(?=[\s<>"\'?&]|$)'
    for match in re.finditer(pattern, text):
        owner, repo, lane, number, kind, identifier = match.groups()
        repo = owner + '/' + repo
        if repo.lower() not in {x.lower() for x in REPOS}:
            continue
        repo = next(x for x in REPOS if x.lower() == repo.lower())
        targets.append({'repo': repo, 'number': int(number), 'lane': lane,
                        'kind': kind or 'thread', 'commentId': int(identifier) if identifier else None,
                        'url': match.group(0)})
    if not targets:
        return None
    anchored = [item for item in targets if item['commentId']]
    # Cross-linked issues in the comment must not redirect this reply.
    targets = [item for item in anchored or targets if f'[{item["repo"]}]'.lower() in subject]
    numbers = re.findall(r'\((?:Issue|PR) #(\d+)\)', message.get('subject', ''), re.I)
    if numbers:
        targets = [item for item in targets if item['number'] == int(numbers[-1])]
    unique = {(item['repo'], item['number'], item['kind'], item['commentId']): item for item in targets}
    if len(unique) != 1:
        return None
    return next(iter(unique.values()))


def item_key(target, message_id):
    identity = target['number'] if target['kind'] == 'workflow' else target['commentId'] or message_id
    raw = f'{target["repo"]}:{target["number"]}:{target["kind"]}:{identity}'
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def wake():
    import win32event
    signal = win32event.CreateEvent(None, False, False, EVENT_NAME)
    win32event.SetEvent(signal)
    signal.Close()


def enqueue_email(message_id):
    message = fetch_email(message_id)
    target = target_from_email(message)
    if not target:
        return {'result': 'ignored', 'reason': 'No unambiguous allowed thread'}
    route = ('actions/runs' if target['kind'] == 'workflow' else 'issues')
    thread = gh(f'repos/{target["repo"]}/{route}/{target["number"]}')
    if target['kind'] == 'workflow' and thread.get('conclusion') not in ('failure', 'timed_out', 'action_required'):
        return {'result': 'ignored', 'reason': 'Workflow has no current failure'}
    if not followed_thread(target, thread):
        return {'result': 'ignored', 'reason': 'Upstream thread has no post by Brooks'}
    key = item_key(target, message_id)
    with lock('state.lock'):
        saved = state()
        if key in saved['items']:
            return {'result': 'duplicate', 'key': key}
        saved['items'][key] = {'key': key, 'target': target, 'messageId': message_id,
                               'receivedAt': message['receivedDateTime'], 'queuedAt': now(),
                               'status': 'pending', 'title': thread.get('title') or thread.get('name')}
        write(ROOT / 'state.json', saved)
    wake()
    return {'result': 'queued', 'key': key, 'target': target}


def all_comments(target):
    repo, number = target['repo'], target['number']
    if target['kind'] == 'discussion_r':
        route = f'repos/{repo}/pulls/{number}/comments'
    else:
        route = f'repos/{repo}/issues/{number}/comments'
    return list(thread_entries(route))


def thread_entries(route):
    for page in range(1, 21):
        entries = gh(f'{route}?per_page=100&page={page}')
        yield from entries
        if len(entries) < 100:
            return
    raise RuntimeError('Thread exceeds the reviewed comment limit')


def followed_thread(target, thread):
    if target['repo'] != 'stablyai/orca' or (thread.get('user') or {}).get('login') == SELF:
        return True
    repo, number = target['repo'], target['number']
    if any((entry.get('user') or {}).get('login') == SELF
           for entry in thread_entries(f'repos/{repo}/issues/{number}/comments')):
        return True
    if not isinstance(thread.get('pull_request'), dict):
        return False
    reviews = list(thread_entries(f'repos/{repo}/pulls/{number}/reviews'))
    submitted = [entry for entry in reviews if entry.get('state') in ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED')]
    if any((entry.get('user') or {}).get('login') == SELF for entry in submitted):
        return True
    submitted_ids = {entry['id'] for entry in submitted if entry.get('id') is not None}
    return any((entry.get('user') or {}).get('login') == SELF and entry.get('pull_request_review_id') in submitted_ids
               for entry in thread_entries(f'repos/{repo}/pulls/{number}/comments'))


def finish(key, reason, reply=None, run_token=None):
    if not reason.strip():
        raise ValueError('A decision reason is required')
    with lock('state.lock'):
        saved = state()
        item = saved['items'][key]
        if run_token and item.get('runToken') != run_token:
            raise ValueError('This item belongs to another review batch')
        if item['status'] == 'handled':
            return item
        if run_token and (item['status'] != 'pending' or (saved['activeRun'] or {}).get('token') != run_token):
            return {'result': 'expired_batch', 'reason': 'This reviewer no longer owns the pending item'}
        target = item['target']
        if reply is not None:
            if target['kind'] == 'workflow':
                raise ValueError('A workflow alert cannot receive a public reply')
            body = Path(reply).read_text(encoding='utf-8-sig').strip()
            if not body or len(body) > 3000 or '\u2014' in body:
                raise ValueError('Reply must be concise and contain no em dash')
            if target['repo'] not in REPOS:
                raise ValueError('Reply repository is not allowed')
            thread = gh(f'repos/{target["repo"]}/issues/{target["number"]}')
            if not followed_thread(target, thread):
                raise ValueError('Upstream thread no longer has a post by Brooks')
            marker = f'<!-- orca-agency-email:{key} -->'
            existing = [c for c in all_comments(target) if (c.get('user') or {}).get('login') == SELF and marker in (c.get('body') or '')]
            if existing:
                item['replyUrl'] = existing[0]['html_url']
            elif item.get('postAttemptAt'):
                raise RuntimeError('Prior reply outcome is uncertain; inspect GitHub before retrying')
            else:
                comment = thread
                if target['commentId']:
                    kind = target['kind']
                    route = ('pulls/comments' if kind == 'discussion_r' else f'pulls/{target["number"]}/reviews' if kind == 'pullrequestreview-' else 'issues/comments')
                    comment = gh(f'repos/{target["repo"]}/{route}/{target["commentId"]}')
                    expected = f'https://github.com/{target["repo"]}/'
                    actual = comment.get('html_url', '')
                    if not any(actual.startswith(expected + lane + f'/{target["number"]}#') for lane in ('issues', 'pull')):
                        raise ValueError('Comment does not belong to the verified thread')
                if (comment.get('user') or {}).get('login') == SELF or (comment.get('user') or {}).get('type') == 'Bot':
                    raise ValueError('Do not automatically reply to self or bots')
                item['postAttemptAt'] = now()
                write(ROOT / 'state.json', saved)
                route = (f'repos/{target["repo"]}/pulls/{target["number"]}/comments/{target["commentId"]}/replies'
                         if target['kind'] == 'discussion_r' else f'repos/{target["repo"]}/issues/{target["number"]}/comments')
                posted = gh(route, method='POST', body={'body': body + '\n\n' + marker})
                item['replyUrl'] = posted['html_url']
        item.update(status='handled', decision='reply' if reply else 'no_reply', reason=reason, finishedAt=now())
        if run_token and (saved['activeRun'] or {}).get('token') == run_token:
            saved['activeRun']['lastProgressAt'] = now()
        write(ROOT / 'state.json', saved)
    return item


def complete_run(run_token=None):
    with lock('state.lock'):
        saved = state()
        if run_token and (saved['activeRun'] or {}).get('token') != run_token:
            return {'result': 'expired_batch', 'reason': 'A later batch is already active'}
        saved['lastRun'] = saved['activeRun']
        saved['activeRun'] = None
        write(ROOT / 'state.json', saved)
    wake()
    return {'result': 'completed'}


def heartbeat(run_token):
    if not run_token:
        raise ValueError('A batch token is required')
    with lock('state.lock'):
        saved = state()
        active = saved['activeRun']
        if not active or active.get('token') != run_token:
            return {'result': 'expired_batch'}
        active['lastProgressAt'] = now()
        write(ROOT / 'state.json', saved)
    return {'result': 'progress_recorded'}


def dispatch():
    with lock('state.lock'):
        saved = state()
        for item in saved['items'].values():
            if item['status'] == 'pending' and item.get('attempts', 0) >= 3:
                item.update(status='needs_review', reason='Three review attempts did not record a decision')
        pending = [x for x in saved['items'].values() if x['status'] == 'pending']
        if not pending or saved['activeRun']:
            write(ROOT / 'state.json', saved)
            return
        config = read(ROOT / 'config.json')
        token = uuid.uuid4().hex
        for item in pending:
            item.update(runToken=token)
        saved['activeRun'] = {'startedAt': now(), 'state': 'dispatching', 'token': token}
        write(ROOT / 'state.json', saved)
    try:
        result = json.loads(command([config['orcaExecutable'], 'automations', 'run', config['automationId'], '--json'], timeout=90))
        if not result.get('ok'):
            raise RuntimeError('Orca refused email-triggered dispatch')
        if result['result']['run']['status'] not in ('pending', 'dispatching', 'dispatched'):
            raise RuntimeError('Orca could not launch the notification reviewer')
    except (subprocess.TimeoutExpired, json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, AttributeError):
        write(ROOT / 'last-error.json', {'at': now(), 'operation': 'dispatch', 'error': 'DispatchOutcomeUncertain'})
        RUN_SIGNAL.set()
        return
    except Exception:
        with lock('state.lock'):
            saved = state()
            saved['activeRun'] = None
            write(ROOT / 'state.json', saved)
        raise
    with lock('state.lock'):
        saved = state()
        for item in saved['items'].values():
            if item.get('runToken') == token:
                item['attempts'] = item.get('attempts', 0) + 1
        if saved['activeRun']:
            saved['activeRun'].update(state='running', receipt=result['result'])
        write(ROOT / 'state.json', saved)
    RUN_SIGNAL.set()


def inspect_active_run():
    with lock('state.lock'):
        saved = state()
        active = saved['activeRun']
        if not active:
            return False
    config = read(ROOT / 'config.json')
    result = json.loads(command([config['orcaExecutable'], 'automations', 'runs', '--id', config['automationId'], '--json']))
    if not result.get('ok'):
        raise RuntimeError('Orca run monitoring unavailable')
    run_id = active.get('receipt', {}).get('run', {}).get('id')
    run = next((run for run in result['result']['runs'] if run['id'] == run_id), None)
    ended = run and run['status'] in ('completed', 'dispatch_failed', 'skipped_unavailable', 'skipped_needs_interactive_auth')
    # The CLI call releases the lock. Re-read the lease so a concurrent progress heartbeat wins.
    with lock('state.lock'):
        saved = state()
        current = saved['activeRun']
        if not current:
            return False
        if current.get('token') != active.get('token'):
            return True
        started = datetime.fromisoformat(current['startedAt'].replace('Z', '+00:00')).timestamp()
        elapsed = time.time() - started
        uncertain = not run_id and elapsed > 120
        progress = datetime.fromisoformat(current.get('lastProgressAt', current['startedAt']).replace('Z', '+00:00')).timestamp()
        expired = time.time() - progress > 1800 or elapsed > 14400
        # A renderer completion can precede the reviewer's final queue decision.
        unfinished = any(item['status'] == 'pending' and item.get('runToken') == current.get('token')
                         for item in saved['items'].values())
        if (run and run['status'] == 'completed' and unfinished
                and current.get('lastProgressAt') and time.time() - progress <= 300):
            ended = False
        released = uncertain or expired or ended
        if released:
            saved['lastRun'] = current
            saved['activeRun'] = None
            for item in saved['items'].values():
                if item['status'] == 'pending' and item.get('runToken') == current.get('token'):
                    item.update(status='needs_review', reason='Reviewer ended without recording a decision')
            write(ROOT / 'state.json', saved)
    if released:
        write(ROOT / 'last-error.json', {'at': now(), 'operation': 'run_monitor', 'runId': run_id,
                                        'error': 'DispatchOutcomeUncertain' if uncertain else 'RunExpired' if expired else 'IncompleteBatch'})
        wake()
        return False
    write(ROOT / 'run-health.json', {'at': now(), 'runId': run_id, 'status': run['status'] if run else 'unverifiable'})
    return True


def setup():
    params = read(ROOT / 'outlook-trigger-params.json')
    query = urllib.parse.urlencode({'toolkit_slugs': 'outlook', 'statuses': 'ACTIVE', 'user_ids': params['user_id']})
    accounts = composio_api('connected_accounts?' + query)['items']
    if len(accounts) != 1:
        raise RuntimeError('An unambiguous Outlook account is required')
    params['connected_account_id'] = accounts[0]['id']
    trigger = composio_api('trigger_instances/OUTLOOK_MESSAGE_TRIGGER/upsert', 'POST', params)
    composio_api('trigger_instances/manage/' + trigger['trigger_id'], 'PATCH', {'status': 'enable'})
    config = read(ROOT / 'config.json', {})
    config.update(triggerId=trigger['trigger_id'], connectedAccountId=accounts[0]['id'],
                  userId=params['user_id'], mailbox='brooks@brooksgolden.com', timezone='America/New_York')
    config.setdefault('startAt', now())
    write(ROOT / 'config.json', config)
    return config


def persist_event(message_id):
    with lock('state.lock'):
        saved = state()
        events = saved.setdefault('events', {})
        digest = hashlib.sha256(message_id.encode()).hexdigest()[:24]
        if digest not in events:
            events[digest] = {'messageId': message_id, 'status': 'received', 'at': now()}
            write(ROOT / 'state.json', saved)
        return digest


def process_event(message_id):
    digest = persist_event(message_id)
    for attempt in range(3):
        try:
            with lock('state.lock'):
                if state()['events'][digest]['status'] == 'processed':
                    return
            result = enqueue_email(message_id)
            with lock('state.lock'):
                saved = state()
                saved['events'][digest].update(status='processed', result=result, finishedAt=now())
                write(ROOT / 'state.json', saved)
            return
        except IgnoreNotification as error:
            with lock('state.lock'):
                saved = state()
                saved['events'][digest].update(status='processed', result='ignored', reason=str(error), finishedAt=now())
                write(ROOT / 'state.json', saved)
            return
        except Exception as error:
            with lock('state.lock'):
                saved = state()
                saved['events'][digest].update(status='retry_needed', error=type(error).__name__)
                write(ROOT / 'state.json', saved)
            if attempt < 2:
                time.sleep(2 ** (attempt + 1))
            else:
                raise


def catch_up(inbox, config):
    # One catch-up after connecting, covering downtime. Never a recurring mail check.
    with lock('state.lock'):
        since = state().get('catchUpAt', config['startAt'])
    query = urllib.parse.urlencode({'$filter': f"receivedDateTime ge {since} and from/emailAddress/address eq 'notifications@github.com'",
                                   '$select': 'id,subject,receivedDateTime', '$top': '100', '$orderby': 'receivedDateTime asc'})
    url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?' + query
    for page in range(50):
        mail = json.loads(command([str(Path.home() / '.composio/composio.exe'), 'proxy', url, '--toolkit', 'outlook']))
        if 'error' in mail:
            raise RuntimeError('Notification catch-up failed; cursor retained')
        entries = mail.get('value', [])
        for item in entries:
            if any('[' + repo.lower() + ']' in item.get('subject', '').lower() for repo in REPOS):
                persist_event(item['id'])
                inbox.put(item['id'])
        with lock('state.lock'):
            saved = state()
            if entries:
                saved['catchUpAt'] = entries[-1]['receivedDateTime']
            write(ROOT / 'state.json', saved)
        url = mail.get('@odata.nextLink')
        if not url:
            return
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname != 'graph.microsoft.com' or not parsed.path.startswith('/v1.0/me/'):
            raise ValueError('Invalid Outlook continuation URL')
    raise RuntimeError('Catch-up page bound reached; completed pages were retained')


def listen():
    import websocket
    import win32event
    config = read(ROOT / 'config.json')
    signal = win32event.CreateEvent(None, False, False, EVENT_NAME)
    inbox = queue.Queue()

    def worker():
        while True:
            message = inbox.get()
            try:
                if message:
                    process_event(message)
                dispatch()
            except Exception as error:
                try:
                    write(ROOT / 'last-error.json', {'at': now(), 'operation': 'event', 'error': type(error).__name__})
                except Exception:
                    os._exit(1)  # Let the logon task restart a broken worker.
            finally:
                inbox.task_done()

    def queue_signal():
        while True:
            win32event.WaitForSingleObject(signal, win32event.INFINITE)
            inbox.put(None)

    def monitor_run():
        while True:
            RUN_SIGNAL.wait()
            try:
                if not inspect_active_run():
                    RUN_SIGNAL.clear()
            except Exception as error:
                write(ROOT / 'last-error.json', {'at': now(), 'operation': 'run_monitor', 'error': type(error).__name__})
            if RUN_SIGNAL.is_set():
                time.sleep(180)  # Monitor only active Orca work, never mail or GitHub.

    with lock('listener.lock', timeout=0):
        threading.Thread(target=worker, daemon=True).start()
        threading.Thread(target=queue_signal, daemon=True).start()
        threading.Thread(target=monitor_run, daemon=True).start()
        with lock('state.lock'):
            saved = state()
            if saved['activeRun']:
                RUN_SIGNAL.set()
            for item in saved.get('events', {}).values():
                if item['status'] != 'processed':
                    inbox.put(item['messageId'])
        wake()
        while True:
            try:
                creds = composio_api('cli/realtime/credentials')
                url = f'wss://ws-{creds["pusher_cluster"]}.pusher.com/app/{creds["pusher_key"]}?protocol=7&client=js&version=8.4.0&flash=false'
                with contextlib.closing(websocket.create_connection(url, timeout=45)) as ws:
                    hello = json.loads(ws.recv())
                    socket_id = decoded(hello['data'])['socket_id']
                    channel = 'private-cli-' + creds['project_id']
                    auth = composio_api('cli/realtime/auth', 'POST', {'channel_name': channel, 'socket_id': socket_id})
                    ws.send(json.dumps({'event': 'pusher:subscribe', 'data': {'channel': channel, 'auth': auth['auth']}}))
                    ws.settimeout(60)
                    ping_pending = False
                    chunks = Chunks()
                    while True:
                        try:
                            event = json.loads(ws.recv())
                        except websocket.WebSocketTimeoutException:
                            if ping_pending:
                                raise
                            ws.send(json.dumps({'event': 'pusher:ping', 'data': {}}))
                            ping_pending = True
                            ws.settimeout(20)
                            continue
                        ping_pending = False
                        ws.settimeout(60)
                        if event['event'] == 'pusher:ping':
                            ws.send(json.dumps({'event': 'pusher:pong', 'data': {}}))
                        elif event['event'] == 'pusher_internal:subscription_succeeded':
                            write(ROOT / 'listener-health.json', {'connectedAt': now(), 'pid': os.getpid(), 'triggerId': config['triggerId'], 'state': 'subscribed'})
                            try:
                                catch_up(inbox, config)
                            except Exception as error:
                                write(ROOT / 'last-error.json', {'at': now(), 'operation': 'catch_up', 'error': type(error).__name__})
                        elif event['event'] in ('trigger_to_client', 'chunked-trigger_to_client'):
                            payload = (chunks.add(event['data']) if event['event'].startswith('chunked-') else decoded(event['data']))
                            if payload:
                                identifier = event_message_id(payload, config)
                                if identifier:
                                    persist_event(identifier)
                                    inbox.put(identifier)
            except Exception as error:
                write(ROOT / 'listener-health.json', {'at': now(), 'pid': os.getpid(), 'state': 'reconnecting', 'error': type(error).__name__})
                time.sleep(30)  # Connection recovery only; no mailbox or GitHub poll.


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'listen', 'replay', 'pending', 'finish', 'complete-run', 'heartbeat'])
    parser.add_argument('--message-id')
    parser.add_argument('--key')
    parser.add_argument('--reason')
    parser.add_argument('--reply-file')
    parser.add_argument('--run-token')
    args = parser.parse_args()
    if args.action == 'setup':
        result = setup()
    elif args.action == 'listen':
        listen()
        return
    elif args.action == 'replay':
        process_event(args.message_id)
        result = {'result': 'processed'}
    elif args.action == 'finish':
        result = finish(args.key, args.reason, args.reply_file, args.run_token)
    elif args.action == 'complete-run':
        result = complete_run(args.run_token)
    elif args.action == 'heartbeat':
        result = heartbeat(args.run_token)
    else:
        with lock('state.lock'):
            saved = state()
            token = (saved['activeRun'] or {}).get('token')
            result = {'runToken': token, 'items': [x for x in saved['items'].values()
                       if x['status'] == 'pending' and (not token or x.get('runToken') == token)]}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
