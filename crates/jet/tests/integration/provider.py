#!/usr/bin/env python3
import json, re, sys, time
prompt = sys.stdin.read()
review = '--json-schema' in sys.argv
# A thread that says "hang" keeps the reply, and its notes review, running until it is stopped.
hang = re.search(r'\bhang\b', prompt) is not None
with open('calls', 'a') as calls:
    calls.write('review\n' if review else 'reply\n')
# Every call leaves its arguments and its standard input, for a test that scans what the model was sent.
with open('args.jsonl', 'a') as record:
    record.write(json.dumps({'args': sys.argv[1:], 'input': prompt}) + '\n')
def emit(value):
    print(json.dumps(value), flush=True)
# The turn that answers a colleague from shared objectives: a message to answer in a labelled block
# and the shared objectives. A message that says "unanswerable" cannot be answered from them.
if '<shared_objectives>' in prompt:
    shared = json.loads(prompt.split('<shared_objectives>')[1].split('</shared_objectives>')[0])
    answer = '[CANNOT_ANSWER]' if 'unanswerable' in prompt or not shared else shared[0]['title'] + ' is due ' + shared[0]['due'] + '.'
    emit({'type':'system','subtype':'init','session_id':'fixture-session','model':'fixture-model'})
    emit({'type':'result','subtype':'success','is_error':False,'result':answer,'duration_ms':1,'total_cost_usd':0,'usage':{}})
    sys.exit(0)
if review and not hang:
    # The notes review: what the user said, each line followed by the chat it came from, becomes
    # their RECENT note.
    title, recent = '', []
    for line in prompt.split('\n'):
        chat = re.match(r'\[chat: (.*)\]$', line)
        said = re.match(r'user: (.*)$', line)
        if chat:
            title = chat.group(1)
        elif said:
            recent.append('- ' + said.group(1) + (' [' + title + ']' if title else ''))
    # Every promise it sees, in any line, with the time it names; the server must pick Jet's own.
    # A user line that asks Jet to ease off goes into the USER note.
    promises, user = [], []
    for line in prompt.split('\n'):
        said = re.match(r'(user|Jet): (.*)$', line)
        if not said:
            continue
        for found in re.finditer(r'I will check in(?: on (\d{4}-\d\d-\d\d))?(?: at (\d\d:\d\d))?', said.group(2)):
            day, hour = found.group(1), found.group(2)
            promises.append({'words': found.group(0), 'at': day + 'T' + (hour or '09:00') if day else None})
        if said.group(1) == 'user' and re.search(r'\b(less|ease off)\b', said.group(2)):
            user.append('- ' + said.group(2))
    notes = {'changed': True, 'memory': '', 'user': '\n'.join(user), 'recent': '\n'.join(recent), 'promises': promises}
    emit({'type':'result','subtype':'success','is_error':False,'result':'','structured_output':notes,'duration_ms':1,'total_cost_usd':0,'usage':{}})
    sys.exit(0)
emit({'type':'system','subtype':'init','session_id':'fixture-session','model':'fixture-model'})
emit({'type':'assistant','message':{'role':'assistant','content':[{'type':'tool_use','id':'read-1','name':'mcp__fixture__read','input':{'page':1}}]}})
emit({'type':'user','message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'read-1','content':'{"text":"free fixture"}'}]}})
# A message that says "promiseme" gets a reply in which Jet promises to check in; "quoteme" a reply
# that only quotes someone else's promise; "vaguely" a promise with no time.
reply = 'Partial browser reply'
if 'promiseme' in prompt:
    reply = 'Sure. I will check in on 2090-03-04 at 10:00 to see how it went.'
elif 'vaguely' in prompt:
    reply = 'Sure. I will check in later.'
elif 'quoteme' in prompt:
    reply = 'Your colleague wrote: "I will check in on 2090-03-04 at 10:00" and that is theirs.'
for text in ['mood: neutral\n', reply]:
    emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':text}}})
if 'flood' in prompt:
    for _ in range(600):
        emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'.'}}})
if hang:
    time.sleep(120)
else:
    time.sleep(1)
    emit({'type':'result','subtype':'success','is_error':False,'result':reply,'duration_ms':1000,'total_cost_usd':0,'usage':{}})
