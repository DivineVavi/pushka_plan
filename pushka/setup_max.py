"""Register /plan hints and HTTPS webhook after the bot is configured in MAX."""
import os
import re
from urllib.parse import urlparse
from .bot import MaxClient


def main():
    token = os.getenv('MAX_BOT_TOKEN')
    secret = os.getenv('MAX_WEBHOOK_SECRET')
    origin = os.getenv('PUBLIC_URL', '').rstrip('/')
    if not token or not secret or not origin:
        raise SystemExit('Set MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET and PUBLIC_URL')
    url = urlparse(origin)
    if url.scheme != 'https' or not url.hostname or url.port or url.path or url.query or url.fragment:
        raise SystemExit('PUBLIC_URL must be a publicly reachable HTTPS domain on port 443')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{5,256}', secret):
        raise SystemExit('MAX_WEBHOOK_SECRET must be 5–256 letters, digits, underscores or hyphens')
    client = MaxClient(token)
    client.call('PATCH', '/me/commands', {'commands': [
        {'name':'plan','description':'Составить новый план'},
        {'name':'show','description':'Показать текущий план'},
        {'name':'cancel','description':'Отменить ввод'},
        {'name':'help','description':'Справка'},
    ]})
    result = client.call('POST', '/subscriptions', {'url':origin+'/max/webhook',
        'update_types':['message_created','message_callback','bot_started'], 'secret':secret})
    print('MAX webhook registration submitted for:', origin+'/max/webhook',
          'response:', result.get('status', 'received') if isinstance(result, dict) else 'received')


if __name__ == '__main__':
    main()
