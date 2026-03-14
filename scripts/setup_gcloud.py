import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


COMMON_GCLOUD_PATHS = [
    Path.home() / "AppData" / "Local" / "Google" / "Cloud SDK" / "google-cloud-sdk" / "bin" / "gcloud.cmd",
    Path("C:/Program Files/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"),
]


def run_command(command: list[str], check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=check,
        encoding="utf-8",
        errors="replace",
    )


def find_gcloud() -> Path | None:
    direct = shutil.which("gcloud")
    if direct:
      return Path(direct)

    for candidate in COMMON_GCLOUD_PATHS:
        if candidate.exists():
            return candidate

    return None


def ensure_path(gcloud_path: Path) -> bool:
    gcloud_bin = str(gcloud_path.parent)
    user_path = os.environ.get("PATH", "")

    if gcloud_bin.lower() in user_path.lower():
        return False

    os.environ["PATH"] = f"{gcloud_bin};{user_path}"
    return True


def read_setting(gcloud: Path, args: list[str]) -> tuple[bool, str]:
    result = run_command([str(gcloud), *args])
    success = result.returncode == 0
    output = (result.stdout or result.stderr).strip()
    return success, output


def set_project(gcloud: Path, project_id: str) -> tuple[bool, str]:
    result = run_command([str(gcloud), "config", "set", "project", project_id])
    output = (result.stdout or result.stderr).strip()
    return result.returncode == 0, output


def maybe_adc_login(gcloud: Path) -> tuple[bool, str]:
    result = run_command([str(gcloud), "auth", "application-default", "login"])
    output = (result.stdout or result.stderr).strip()
    return result.returncode == 0, output


def print_section(title: str, body: str) -> None:
    print(f"\n== {title} ==")
    print(body if body else "(no output)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate and repair a local Google Cloud CLI setup."
    )
    parser.add_argument("--project", help="Set the default gcloud project.")
    parser.add_argument(
        "--setup-adc",
        action="store_true",
        help="Run gcloud auth application-default login if ADC is missing.",
    )
    args = parser.parse_args()

    gcloud = find_gcloud()
    if not gcloud:
        print("gcloud was not found. Install Google Cloud CLI first:")
        print("https://cloud.google.com/sdk/docs/install")
        return 1

    path_updated = ensure_path(gcloud)
    print_section("gcloud path", str(gcloud))
    if path_updated:
        print("Added gcloud to the current process PATH for this run.")

    version_ok, version_output = read_setting(gcloud, ["--version"])
    print_section("version", version_output)
    if not version_ok:
        return 1

    auth_ok, auth_output = read_setting(gcloud, ["auth", "list"])
    print_section("auth accounts", auth_output)

    project_ok, project_output = read_setting(gcloud, ["config", "get-value", "project"])
    print_section("default project", project_output)

    config_ok, config_output = read_setting(gcloud, ["config", "list"])
    print_section("config", config_output)

    adc_ok, adc_output = read_setting(
        gcloud, ["auth", "application-default", "print-access-token"]
    )
    print_section("application default credentials", adc_output)

    if args.project:
        set_ok, set_output = set_project(gcloud, args.project)
        print_section("set project", set_output)
        if not set_ok:
            return 1

    if args.setup_adc and not adc_ok:
        login_ok, login_output = maybe_adc_login(gcloud)
        print_section("adc login", login_output)
        if not login_ok:
            return 1

    print("\n== summary ==")
    if "(unset)" in project_output and not args.project:
        print("Default project is not set. Re-run with --project YOUR_PROJECT_ID.")
    else:
        print("Default project looks configured.")

    if not auth_ok:
        print("Interactive user login is missing. Run: gcloud auth login")
    else:
        print("Interactive gcloud login looks configured.")

    if not adc_ok and not args.setup_adc:
        print("ADC is missing. Re-run with --setup-adc to launch ADC login.")
    elif adc_ok:
        print("ADC looks configured.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
