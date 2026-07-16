import re

with open('f:/GO/videomodifyauto/docker/scripts/generate-shots.sh', 'r', encoding='utf-8') as f:
    content = f.read()

old_line = '''    print(f"Shot {shot_index}: Using model {account.get('model_name', 'agnes-video-v2.0')} at {account.get('base_url', '')}")'''
new_line = '''    model_name = account.get('model_name', '').strip() or 'agnes-video-v2.0'
    base_url = account.get('base_url', '').strip()
    print(f"Shot {shot_index}: Using model {model_name} at {base_url}")'''

content = content.replace(old_line, new_line)

with open('f:/GO/videomodifyauto/docker/scripts/generate-shots.sh', 'w', encoding='utf-8') as f:
    f.write(content)

print('File fixed successfully')