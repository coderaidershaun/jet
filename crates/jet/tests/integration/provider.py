#!/usr/bin/env python3
import json, sys, time
prompt = sys.stdin.read()
with open('calls', 'a') as calls:
    calls.write('review\n' if '--json-schema' in sys.argv else 'reply\n')
def emit(value):
    print(json.dumps(value), flush=True)
emit({'type':'system','subtype':'init','session_id':'fixture-session','model':'fixture-model'})
emit({'type':'assistant','message':{'role':'assistant','content':[{'type':'tool_use','id':'read-1','name':'mcp__fixture__read','input':{'page':1}}]}})
emit({'type':'user','message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'read-1','content':'{"text":"free fixture"}'}]}})
for text in ['mood: neutral\n', 'Partial browser reply']:
    emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':text}}})
if 'flood' in prompt:
    for _ in range(600):
        emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'.'}}})
if 'hang' in prompt or '--json-schema' in sys.argv:
    time.sleep(120)
else:
    time.sleep(1)
    emit({'type':'result','subtype':'success','is_error':False,'result':'Partial browser reply','duration_ms':1000,'total_cost_usd':0,'usage':{}})
