#!/usr/bin/env python3
import argparse
import subprocess
import sys
import os
from base64 import b64encode

try:
    import requests
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives import serialization, hashes
except ImportError:
    print("Installing required packages...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "cryptography"])
    import requests
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives import serialization, hashes

def run_cmd(cmd, cwd=None):
    try:
        result = subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True)
        return True, result.stdout
    except subprocess.CalledProcessError as e:
        return False, e.stderr

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
        print(f"  ❌ Failed to get public key: {e}")
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

def check_repo_exists(token, owner, repo):
    url = f"https://api.github.com/repos/{owner}/{repo}"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    response = requests.get(url, headers=headers)
    return response.status_code == 200

def create_repo(token, owner, repo):
    url = f"https://api.github.com/user/repos"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    data = {
        "name": repo,
        "private": True,
        "auto_init": False
    }
    try:
        response = requests.post(url, headers=headers, json=data)
        response.raise_for_status()
        print(f"  ✓ Created repository {owner}/{repo}")
        return True
    except Exception as e:
        print(f"  ❌ Failed to create repo: {e}")
        return False

def deploy_to_account(token, owner, repo, repo_path, secrets):
    print(f"\n{'='*60}")
    print(f"  Deploying to {owner}/{repo}")
    print(f"{'='*60}")
    
    exists = check_repo_exists(token, owner, repo)
    if not exists:
        print(f"  Repository {owner}/{repo} does not exist, creating...")
        if not create_repo(token, owner, repo):
            print(f"  ✗ Skipping {owner}/{repo} due to creation failure")
            return False
    
    remote_url = f"https://{token}@github.com/{owner}/{repo}.git"
    
    print(f"\n  1. Pushing code to {owner}/{repo}...")
    success, output = run_cmd(["git", "push", remote_url, "main"], cwd=repo_path)
    if success:
        print(f"  ✓ Code pushed successfully")
    else:
        print(f"  ✗ Code push failed: {output}")
        return False
    
    print(f"\n  2. Setting secrets for {owner}/{repo}...")
    success_count = 0
    for name, value in secrets:
        if set_secret(token, owner, repo, name, value):
            success_count += 1
    
    print(f"  Result: {success_count}/{len(secrets)} secrets set successfully")
    
    if success_count == len(secrets):
        print(f"\n  ✅ Deployment to {owner}/{repo} completed successfully!")
        return True
    else:
        print(f"\n  ⚠️ Deployment to {owner}/{repo} partially completed")
        return False

def main():
    parser = argparse.ArgumentParser(description="Deploy project to multiple GitHub accounts")
    parser.add_argument("--token", required=True, help="GitHub Personal Access Token with repo scope")
    parser.add_argument("--repo", required=True, help="Repository name")
    parser.add_argument("--owners", required=True, help="Comma-separated list of GitHub account owners")
    parser.add_argument("--repo-path", default=".", help="Local repository path")
    
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
    print("  GitHub Multi-Account Deployment Script")
    print("=" * 60)
    print(f"Repository: {args.repo}")
    print(f"Local path: {os.path.abspath(args.repo_path)}")
    print(f"Target owners: {', '.join(owners)}")
    print(f"Total secrets: {len(secrets)}")
    print("-" * 60)
    
    success_count = 0
    total = len(owners)
    
    for owner in owners:
        if deploy_to_account(args.token, owner, args.repo, args.repo_path, secrets):
            success_count += 1
    
    print("\n" + "=" * 60)
    print(f"  Summary: {success_count}/{total} accounts deployed successfully")
    print("=" * 60)
    
    if success_count < total:
        sys.exit(1)

if __name__ == "__main__":
    main()