import importlib
from importlib.machinery import PathFinder
from contextlib import contextmanager
import json
import os
import subprocess
import sys
from pathlib import Path


TASKS = {
    "psf__requests-2931": ("psf/requests", "requests"),
    "psf__requests-5414": ("psf/requests", "requests"),
    "psf__requests-6028": ("psf/requests", "requests"),
    "sympy__sympy-16886": ("sympy/sympy", "sympy"),
    "sympy__sympy-19346": ("sympy/sympy", "sympy"),
    "sympy__sympy-24562": ("sympy/sympy", "sympy"),
}
DEPENDENCIES = ("certifi", "chardet", "charset_normalizer", "idna", "mpmath", "urllib3")


class GraderInfrastructureError(RuntimeError):
    pass


@contextmanager
def candidate_output():
    stdout = sys.stdout
    stdout.flush()
    descriptor = stdout.fileno()
    saved = os.dup(descriptor)
    os.dup2(sys.stderr.fileno(), descriptor)
    try:
        yield
    finally:
        try:
            stdout.flush()
        finally:
            os.dup2(saved, descriptor)
            os.close(saved)
            sys.stdout = stdout


def validate_environment(task):
    if task not in TASKS:
        raise GraderInfrastructureError("unknown-task")
    repository, package = TASKS[task]
    root = Path.cwd().resolve()
    try:
        top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True, stderr=subprocess.DEVNULL).strip()
        origin = subprocess.check_output(["git", "config", "--get", "remote.origin.url"], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise GraderInfrastructureError("unverified-candidate-root") from error
    origin = origin.removeprefix("https://github.com/").removeprefix("git@github.com:").removesuffix(".git").rstrip("/")
    if Path(top).resolve() != root or origin.lower() != repository:
        raise GraderInfrastructureError("unverified-candidate-root")
    sys.path = [path for path in sys.path if not Path(path or ".").resolve().is_relative_to(root)]
    for name in DEPENDENCIES:
        try:
            dependency = importlib.import_module(name)
            if Path(dependency.__file__).resolve().is_relative_to(root):
                raise ValueError("candidate-shadowed-environment-dependency")
        except Exception as error:
            raise GraderInfrastructureError(f"declared-dependency-unavailable:{name}") from error
    if package in sys.modules:
        raise GraderInfrastructureError("candidate-package-already-imported")
    candidate = PathFinder.find_spec(package, [str(root)])
    if candidate is None or candidate.origin is None:
        raise RuntimeError("candidate-package-missing")
    if not Path(candidate.origin).resolve().is_relative_to(root / package):
        raise GraderInfrastructureError("candidate-package-origin-mismatch")
    sys.path.insert(0, str(root))


def require(condition):
    if not condition:
        raise AssertionError("behavioral-check-failed")


def grade(task):
    if task.startswith("psf__requests"):
        requests = importlib.import_module("requests")
        require(Path(requests.__file__).resolve().is_relative_to(Path.cwd().resolve()))
        if task.endswith("-2931"):
            payload = "ööö".encode("utf-8")
            try:
                request = requests.Request("PUT", "http://example.com", data=payload).prepare()
            except UnicodeDecodeError as error:
                raise AssertionError("binary-payload-decoding-regression") from error
            require(isinstance(request.body, bytes) and request.body == payload)
            require(requests.Request("GET", "http://example.com").prepare().body is None)
            require(requests.Request("POST", "http://example.com", data="plain").prepare().body == "plain")
        elif task.endswith("-5414"):
            for host in [".example.com", "*example.com"]:
                try:
                    requests.Request("GET", f"http://{host}").prepare()
                except requests.exceptions.InvalidURL:
                    pass
                except Exception as error:
                    raise AssertionError("wrong-exception-type") from error
                else:
                    raise AssertionError("missing-invalid-url-exception")
            require(requests.Request("GET", "http://example.com/path").prepare().url == "http://example.com/path")
        elif task.endswith("-6028"):
            for value in ["http://user:pass@example.com/path?query", "http://user@example.com/path?query"]:
                require(requests.utils.prepend_scheme_if_needed(value, "http") == value)
            require(requests.utils.prepend_scheme_if_needed("example.com/path", "http") == "http://example.com/path")
        else:
            raise ValueError("unknown-task")
    else:
        sympy = importlib.import_module("sympy")
        require(Path(sympy.__file__).resolve().is_relative_to(Path.cwd().resolve()))
        if task.endswith("-16886"):
            from sympy.crypto.crypto import decode_morse, encode_morse
            require(encode_morse("12345") == ".----|..---|...--|....-|.....")
            require(encode_morse("67890") == "-....|--...|---..|----.|-----")
            require(decode_morse(".----") == "1")
            require(encode_morse("SOS") == "...|---|...")
        elif task.endswith("-19346"):
            from sympy import srepr
            from sympy.abc import x, y, z
            require(srepr({}) == "{}")
            require(srepr({x: y}) == "{Symbol('x'): Symbol('y')}")
            require(srepr({x: {y: z}}) == "{Symbol('x'): {Symbol('y'): Symbol('z')}}")
            require(srepr(set()) == "set()")
            require(srepr({x, y}) in ["{Symbol('x'), Symbol('y')}", "{Symbol('y'), Symbol('x')}"])
            require(srepr([x, y]) == "[Symbol('x'), Symbol('y')]")
        elif task.endswith("-24562"):
            from sympy import Rational
            for numerator in ["1.5", 1.5, 2]:
                for denominator in ["1.5", 1.5, 2]:
                    try:
                        require(Rational(numerator, denominator).as_numer_denom() == Rational(f"{numerator}/{denominator}").as_numer_denom())
                    except TypeError as error:
                        raise AssertionError("rational-string-calculation-regression") from error
            require(Rational("0.5", "100") == Rational(1, 200))
        else:
            raise ValueError("unknown-task")


if __name__ == "__main__":
    try:
        validate_environment(sys.argv[1] if len(sys.argv) == 2 else None)
        with candidate_output():
            grade(sys.argv[1])
    except GraderInfrastructureError as error:
        print(json.dumps({"verdict": "infrastructure-invalid", "healthy": False, "exception": type(error).__name__, "reason": str(error)}))
        raise
    except AssertionError as error:
        print(json.dumps({"verdict": "fail", "healthy": True, "reason": str(error)}))
        sys.exit(1)
    except (Exception, SystemExit) as error:
        print(json.dumps({"verdict": "fail", "healthy": True, "exception": type(error).__name__, "reason": str(error)}))
        sys.exit(1)
    else:
        print(json.dumps({"verdict": "pass", "healthy": True}))
