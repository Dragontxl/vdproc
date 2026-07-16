#!/usr/bin/env python3
import argparse
import json
import sys
from base64 import b64encode

try:
    import requests
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives import serialization, hashes
except ImportError:
    print("Installing required packages...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "cryptography"])
    import requests
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives import serialization, hashes

def get_public_key(token, owner, repo):
    url = f"https://api.github.com/repos/{owner}/{repo}/actions/secrets/public-key"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"  ❌ Failed to get public key for {owner}/{repo}: {e}")
        return None

def encrypt_secret(public_key_pem, value):
    public_key = serialization.load_pem_public_key(public_key_pem.encode())
    encrypted = public_key.encrypt(
        value.encode(),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    return b64encode(encrypted).decode()

def set_secret(token, owner, repo, secret_name, value):
    pub_key = get_public_key(token, owner, repo)
    if not pub_key:
        return False
    
    encrypted_value = encrypt_secret(pub_key['key'], value)
    key_id = pub_key['key_id']
    
    url = f"https://api.github.com/repos/{owner}/{repo}/actions/secrets/{secret_name}"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    data = {
        "encrypted_value": encrypted_value,
        "key_id": key_id
    }
    
    try:
        response = requests.put(url, headers=headers, json=data)
        response.raise_for_status()
        print(f"  ✓ {secret_name}")
        return True
    except Exception as e:
        print(f"  ❌ {secret_name}: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Setup GitHub Actions secrets across multiple accounts")
    parser.add_argument("--token", required=True, help="GitHub Personal Access Token with repo scope")
    parser.add_argument("--repo", required=True, help="Repository name (same across all accounts)")
    parser.add_argument("--owners", required=True, help="Comma-separated list of GitHub account owners")
    
    parser.add_argument("--r2-access-key", required=True, help="R2_ACCESS_KEY_ID")
    parser.add_argument("--r2-secret-key", required=True, help="R2_SECRET_ACCESS_KEY")
    parser.add_argument("--r2-endpoint", required=True, help="R2_ENDPOINT_URL")
    parser.add_argument("--r2-bucket", required=True, help="R2_BUCKET_NAME")
    
    parser.add_argument("--callback-url", required=True, help="CALLBACK_URL")
    parser.add_argument("--callback-secret", required=True, help="CALLBACK_SECRET")
    parser.add_argument("--backend-api-key", required=True, help="BACKEND_API_KEY")
    
    parser.add_argument("--ai-api-key", help="AI_API_KEY (optional)")
    parser.add_argument("--ai-base-url", help="AI_BASE_URL (optional)")
    
    args = parser.parse_args()
    
    owners = [o.strip() for o in args.owners.split(",")]
    
    secrets = [
        ("R2_ACCESS_KEY_ID", args.r2_access_key),
        ("R2_SECRET_ACCESS_KEY", args.r2_secret_key),
        ("R2_ENDPOINT_URL", args.r2_endpoint),
        ("R2_BUCKET_NAME", args.r2_bucket),
        ("CALLBACK_URL", args.callback_url),
        ("CALLBACK_SECRET", args.callback_secret),
        ("BACKEND_API_KEY", args.backend_api_key),
    ]
    
    if args.ai_api_key:
        secrets.append(("AI_API_KEY", args.ai_api_key))
    if args.ai_base_url:
        secrets.append(("AI_BASE_URL", args.ai_base_url))
    
    print("=" * 60)
    print("  GitHub Secrets Setup Script")
    print("=" * 60)
    print(f"Repository: {args.repo}")
    print(f"Owners: {', '.join(owners)}")
    print(f"Total secrets to set: {len(secrets)}")
    print("-" * 60)
    
    for owner in owners:
        print(f"\nSetting secrets for {owner}/{args.repo}...")
        success_count = 0
        
        for name, value in secrets:
            if set_secret(args.token, owner, args.repo, name, value):
                success_count += 1
        
        print(f"  Result: {success_count}/{len(secrets)} secrets set successfully")
    
    print("\n" + "=" * 60)
    print("  Done!")
    print("=" * 60)

if __name__ == "__main__":
    main()