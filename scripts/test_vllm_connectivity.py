#!/usr/bin/env python3
"""Connectivity tester for a local or remote vLLM OpenAI-compatible server.

This script focuses on OpenAI-compatible endpoints only.

Default target:
  - base_url: http://localhost:8003/v1
  - model: claude-3-5-sonnet-20241022
  - api_key: EMPTY

Examples:
  python scripts/test_vllm_connectivity.py
  python scripts/test_vllm_connectivity.py --base-url http://100.91.101.3:8003/v1
  python scripts/test_vllm_connectivity.py --api-key EMPTY --verbose
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


DEFAULT_BASE_URL = "http://localhost:8003/v1"
DEFAULT_MODEL = "claude-3-5-sonnet-20241022"
DEFAULT_API_KEY = "EMPTY"
DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1,100.91.101.3,100.115.84.122"


@dataclass
class Result:
    name: str
    method: str
    url: str
    status: int | None
    ok: bool
    body_preview: str
    error: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Test connectivity and generation on a vLLM OpenAI-compatible API."
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-key", default=DEFAULT_API_KEY)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument(
        "--ignore-proxy",
        action="store_true",
        help="Ignore system/env proxy settings and connect directly.",
    )
    parser.add_argument(
        "--no-proxy",
        default=DEFAULT_NO_PROXY,
        help="Comma-separated hosts/IPs for NO_PROXY when not using --ignore-proxy.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print response previews for every check.",
    )
    return parser.parse_args()


def trimmed(text: str, limit: int = 280) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def build_root_url(base_url: str) -> str:
    parsed = urllib.parse.urlparse(base_url.rstrip("/"))
    path = parsed.path
    if path.endswith("/v1"):
        path = path[: -len("/v1")]
    rebuilt = parsed._replace(path=path or "", params="", query="", fragment="")
    return urllib.parse.urlunparse(rebuilt).rstrip("/")


def build_headers(mode: str, api_key: str) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "vllm-connectivity-tester/1.0",
    }

    if mode == "no_auth":
        return headers
    if mode == "bearer":
        headers["Authorization"] = f"Bearer {api_key}"
        return headers
    if mode == "authorization_raw":
        headers["Authorization"] = api_key
        return headers
    if mode == "x_api_key":
        headers["x-api-key"] = api_key
        return headers
    if mode == "api_key":
        headers["api-key"] = api_key
        return headers

    raise ValueError(f"Unsupported header mode: {mode}")


def configure_proxy_behavior(ignore_proxy: bool, no_proxy_value: str) -> None:
    if ignore_proxy:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        urllib.request.install_opener(opener)
        return

    os.environ["NO_PROXY"] = no_proxy_value
    os.environ["no_proxy"] = no_proxy_value


def request_json(
    name: str,
    method: str,
    url: str,
    timeout: float,
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> Result:
    encoded = None
    if payload is not None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url=url, method=method.upper(), headers=headers or {}, data=encoded)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return Result(
                name=name,
                method=method.upper(),
                url=url,
                status=response.status,
                ok=200 <= response.status < 300,
                body_preview=trimmed(body),
            )
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return Result(
            name=name,
            method=method.upper(),
            url=url,
            status=exc.code,
            ok=False,
            body_preview=trimmed(body),
            error=str(exc),
        )
    except Exception as exc:  # noqa: BLE001
        return Result(
            name=name,
            method=method.upper(),
            url=url,
            status=None,
            ok=False,
            body_preview="",
            error=str(exc),
        )


def print_section(title: str) -> None:
    print()
    print(title)
    print("-" * len(title))


def print_result(result: Result, verbose: bool) -> None:
    marker = "PASS" if result.ok else "FAIL"
    status = result.status if result.status is not None else "NO_RESPONSE"
    print(f"[{marker}] {result.name} -> {status}")
    if verbose:
        print(f"  {result.method} {result.url}")
        if result.error:
            print(f"  error: {result.error}")
        if result.body_preview:
            print(f"  body: {result.body_preview}")


def main() -> int:
    args = parse_args()
    configure_proxy_behavior(args.ignore_proxy, args.no_proxy)
    base_url = args.base_url.rstrip("/")
    root_url = build_root_url(base_url)
    model = args.model

    print("vLLM OpenAI-compatible connectivity test")
    print(f"base_url: {base_url}")
    print(f"root_url: {root_url}")
    print(f"model:    {model}")
    print(f"proxy:    {'ignore system proxy' if args.ignore_proxy else f'NO_PROXY={args.no_proxy}'}")

    control_checks = [
        ("health", "GET", f"{root_url}/health", "no_auth", None),
        ("version", "GET", f"{root_url}/version", "no_auth", None),
        ("load", "GET", f"{root_url}/load", "no_auth", None),
        ("models", "GET", f"{base_url}/models", "no_auth", None),
    ]

    print_section("Control plane")
    control_results: list[Result] = []
    for name, method, url, header_mode, payload in control_checks:
        result = request_json(
            name=name,
            method=method,
            url=url,
            timeout=args.timeout,
            headers=build_headers(header_mode, args.api_key),
            payload=payload,
        )
        control_results.append(result)
        print_result(result, args.verbose)

    auth_modes = [
        ("no_auth", "No auth header"),
        ("bearer", "Authorization: Bearer <api_key>"),
        ("authorization_raw", "Authorization: <api_key>"),
        ("x_api_key", "x-api-key: <api_key>"),
        ("api_key", "api-key: <api_key>"),
    ]

    print_section("Model listing with auth variants")
    auth_results: list[Result] = []
    for mode, label in auth_modes:
        result = request_json(
            name=f"models ({label})",
            method="GET",
            url=f"{base_url}/models",
            timeout=args.timeout,
            headers=build_headers(mode, args.api_key),
        )
        auth_results.append(result)
        print_result(result, args.verbose)

    generation_checks = [
        (
            "chat.completions",
            f"{base_url}/chat/completions",
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": "You are a connectivity tester."},
                    {"role": "user", "content": "Reply with exactly: connectivity_ok"},
                ],
                "temperature": 0,
                "max_tokens": 32,
            },
        ),
        (
            "responses",
            f"{base_url}/responses",
            {
                "model": model,
                "input": "Reply with exactly: connectivity_ok",
                "max_output_tokens": 32,
            },
        ),
        (
            "completions",
            f"{base_url}/completions",
            {
                "model": model,
                "prompt": "Reply with exactly: connectivity_ok",
                "temperature": 0,
                "max_tokens": 32,
            },
        ),
        (
            "chat.completions json_object",
            f"{base_url}/chat/completions",
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": "Return JSON only."},
                    {
                        "role": "user",
                        "content": "Return a JSON object with keys status and model.",
                    },
                ],
                "temperature": 0,
                "max_tokens": 64,
                "response_format": {"type": "json_object"},
            },
        ),
    ]

    print_section("Generation checks")
    generation_results: list[Result] = []
    for endpoint_name, url, payload in generation_checks:
        for mode, label in auth_modes:
            result = request_json(
                name=f"{endpoint_name} ({label})",
                method="POST",
                url=url,
                timeout=max(args.timeout, 15.0),
                headers=build_headers(mode, args.api_key),
                payload=payload,
            )
            generation_results.append(result)
            print_result(result, args.verbose)

    print_section("Summary")
    control_ok = all(result.ok for result in control_results)
    any_model_listing_ok = any(result.ok for result in auth_results)
    any_generation_ok = any(result.ok for result in generation_results)

    print(f"control_plane_ok:      {control_ok}")
    print(f"any_auth_variant_ok:   {any_model_listing_ok}")
    print(f"any_generation_ok:     {any_generation_ok}")

    if control_ok and not any_generation_ok:
        print(
            textwrap.dedent(
                """
                Diagnosis:
                  Control plane looks reachable, but every generation path failed.
                  This usually means the server is up while inference/model execution is broken.
                """
            ).strip()
        )
        return 2

    if not control_ok:
        print(
            textwrap.dedent(
                """
                Diagnosis:
                  Basic service endpoints are not healthy or not reachable.
                  Check whether the vLLM container is running and port 8003 is exposed.
                """
            ).strip()
        )
        return 1

    if any_generation_ok:
        print("Diagnosis:\n  At least one OpenAI-compatible generation path is working.")
        return 0

    print(
        textwrap.dedent(
            """
            Diagnosis:
              Service is partially reachable, but no fully successful generation path was detected.
              Review logs and auth header handling.
            """
        ).strip()
    )
    return 3


if __name__ == "__main__":
    sys.exit(main())
