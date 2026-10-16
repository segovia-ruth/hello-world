#!/usr/bin/env python3
"""Local LeafTutor frontend backed by the real server.

Install requirements.txt, then run: python localweb.py
Open http://127.0.0.1:5000. Edit templates/ and static/, then refresh.
"""
import argparse
import json
import logging
from http.cookies import SimpleCookie
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from datetime import datetime

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, url_for

from localweb_context import ContextError, page_context, roster_context

UPSTREAM = "https://leaftutor.org"
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}



def local_url(value, upstream):
    """Localize same-backend navigation only."""
    parts = urlsplit(value)
    if parts.scheme and parts.scheme not in ("http", "https"):
        raise ContextError("Unsupported navigation URL from the backend.")
    if parts.netloc and parts.netloc != urlsplit(upstream).netloc:
        raise ContextError(
            "The backend returned a navigation URL outside LeafTutor.")
    path = parts.path or "/"
    if not path.startswith("/") or path.startswith("//") or "\\" in path:
        raise ContextError("The backend returned an invalid navigation path.")
    return urlunsplit(("", "", path, parts.query, parts.fragment))


def local_cookie(value):
    """Keep signed value, expiry, HttpOnly and path; adapt to local HTTP."""
    cookie = SimpleCookie()
    cookie.load(value)
    if not cookie:
        raise ContextError("The backend returned an unreadable cookie.")
    result = []
    for item in cookie.values():
        item["domain"] = ""
        item["secure"] = ""
        if item["samesite"].lower() == "none":
            item["samesite"] = "Lax"
        result.append(item.OutputString())
    return result


def create_app(upstream=UPSTREAM, transport=None):
    app = Flask(__name__)
    app.config.update(UPSTREAM=upstream.rstrip("/"), SEND_FILE_MAX_AGE_DEFAULT=0,
                      TEMPLATES_AUTO_RELOAD=True)
    # Independent requests: no global cookie jar shared between users.
    app.config["UPSTREAM_TRANSPORT"] = transport or requests.request
    app.jinja_env.globals["static_v"] = lambda path: url_for(
        "static", filename=path)

    def nice_date(value):
        try:
            return datetime.strptime(str(value)[:10], "%Y-%m-%d").strftime("%a, %b %-d, %Y")
        except (TypeError, ValueError):
            return value or ""
    app.jinja_env.filters["nice_date"] = nice_date

    def exchange(path=None, method=None, body=None, extra_headers=None):
        path = path or request.full_path.rstrip("?")
        headers = {key: request.headers[key] for key in (
            "Content-Type", "X-Requested-With", "X-LT-Actor", "Cookie", "Authorization",
            "Accept", "Accept-Language", "User-Agent", "Range", "If-Range",
            "X-CSRFToken", "X-CSRF-Token") if key in request.headers}
        headers["Accept-Encoding"] = "identity"
        if "Origin" in request.headers:
            headers["Origin"] = app.config["UPSTREAM"]
        if "Referer" in request.headers:
            ref = urlsplit(request.headers["Referer"])
            headers["Referer"] = app.config["UPSTREAM"] + (ref.path or "/")
        headers.update(extra_headers or {})
        return app.config["UPSTREAM_TRANSPORT"](
            method or request.method, app.config["UPSTREAM"] + path,
            headers=headers, data=request.get_data() if body is None else body,
            allow_redirects=False, stream=True, timeout=(10, 180))

    def cookies(response, remote):
        for value in remote.raw.headers.getlist("Set-Cookie"):
            for adjusted in local_cookie(value):
                response.headers.add("Set-Cookie", adjusted)
        return response

    def navigation(remote):
        response = redirect(local_url(remote.headers.get("Location", "/"),
                                      app.config["UPSTREAM"]), code=remote.status_code)
        return cookies(response, remote)

    def local_page(remote, path):
        try:
            if 300 <= remote.status_code < 400 and "Location" in remote.headers:
                return navigation(remote)
            if remote.status_code == 401 and not path.startswith(("/t/", "/ta/")):
                return cookies(redirect("/login"), remote)
            if remote.status_code >= 400 and not path.startswith("/t/"):
                return cookies(Response(render_template("local_error.html",
                                                        heading="Page unavailable", message="LeafTutor could not open this page.",
                                                        detail=f"Backend response: {remote.status_code}"),
                                        status=remote.status_code), remote)
            name, context = page_context(
                path, remote.text, app.config["UPSTREAM"])
            if context.get("anon_share_url", "") and context["anon_share_url"].startswith("/"):
                context["anon_share_url"] = request.host_url.rstrip(
                    "/") + context["anon_share_url"]
            return cookies(Response(render_template(name, **context),
                                    status=remote.status_code), remote)
        finally:
            remote.close()

    def relay(remote):
        if remote.status_code in (204, 304) or request.method == "HEAD":
            try:
                return cookies(Response(status=remote.status_code), remote)
            finally:
                remote.close()
        if 300 <= remote.status_code < 400 and "Location" in remote.headers:
            try:
                return navigation(remote)
            finally:
                remote.close()
        content_type = remote.headers.get("Content-Type", "")
        if "text/html" in content_type and "attachment" not in remote.headers.get("Content-Disposition", ""):
            if request.path.startswith("/t/"):
                return local_page(remote, request.path)
            if not request.path.startswith("/api/"):
                try:
                    return cookies(Response(render_template("local_error.html",
                                                            heading="Page unavailable", message="This page has no local template yet.",
                                                            detail="Requested path: " + request.path),
                                            status=remote.status_code if remote.status_code >= 400 else 501), remote)
                finally:
                    remote.close()
        if "application/json" in content_type:
            try:
                data = remote.json()

                def rewrite(value):
                    if isinstance(value, list):
                        return [rewrite(v) for v in value]
                    if isinstance(value, dict):
                        return {k: (("" if k == "next" else request.host_url.rstrip("/")) + local_url(v, app.config["UPSTREAM"])
                                    if k in {"next", "chat_url", "share_url", "login_url", "url"}
                                    and isinstance(v, str) and v.startswith(app.config["UPSTREAM"] + "/")
                                    else rewrite(v)) for k, v in value.items()}
                    return value
                response = jsonify(rewrite(data))
                response.status_code = remote.status_code
                for key in ("Retry-After", "WWW-Authenticate"):
                    if key in remote.headers:
                        response.headers[key] = remote.headers[key]
                return cookies(response, remote)
            finally:
                remote.close()

        def chunks():
            try:
                yield from remote.iter_content(chunk_size=8192)
            finally:
                remote.close()
        response = Response(chunks(), status=remote.status_code)
        skip = HOP_HEADERS | {"content-length",
                              "content-encoding", "set-cookie", "server", "date"}
        skip |= {s.strip().lower()
                 for s in remote.headers.get("Connection", "").split(",")}
        for key, value in remote.headers.items():
            if key.lower() not in skip:
                response.headers[key] = value
        cookies(response, remote)
        response.call_on_close(remote.close)
        return response

    @app.before_request
    def check_origin():
        origin = request.headers.get("Origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != request.host_url.rstrip("/"):
            return jsonify(ok=False, error="Request origin does not match this local server."), 403

    @app.after_request
    def no_cache(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.errorhandler(requests.RequestException)
    def network_error(error):
        message = "Unable to reach LeafTutor. Please try again."
        if request.is_json or request.path.startswith("/api/"):
            return jsonify(ok=False, error=message), 502
        return render_template("local_error.html", heading="Connection unavailable",
                               message=message, detail=""), 502

    @app.errorhandler(ContextError)
    def context_error(error):
        return render_template("local_error.html", heading="Page configuration unavailable",
                               message="The local page could not read the configuration supplied by LeafTutor.",
                               detail=str(error)), 502

    @app.get("/")
    @app.get("/login")
    def login_page():
        remote = exchange("/api/me", "GET", b"")
        try:
            identity = remote.json() if remote.status_code == 200 else {}
            if identity.get("logged_in"):
                destination = "/courses" if identity.get(
                    "role") == "instructor" else "/student"
                return cookies(redirect(destination), remote)
            if remote.status_code >= 500:
                raise requests.ConnectionError("Backend unavailable")
            return cookies(Response(render_template("LT_loging_slight_mu.html")), remote)
        finally:
            remote.close()

    @app.post("/login")
    def login_submit():
        remote = exchange(extra_headers={"X-Requested-With": "XMLHttpRequest"})
        try:
            destination = None
            data = {}
            if "application/json" in remote.headers.get("Content-Type", ""):
                data = remote.json()
                if remote.status_code < 300 and data.get("ok"):
                    destination = local_url(
                        data.get("next") or "/", app.config["UPSTREAM"])
                    if urlsplit(destination).path == "/instructor":
                        destination = "/courses"   # instructors start on the course list
            elif 300 <= remote.status_code < 400:
                candidate = local_url(remote.headers.get(
                    "Location", "/"), app.config["UPSTREAM"])
                if urlsplit(candidate).path in ("/student", "/instructor"):
                    destination = "/courses" if urlsplit(candidate).path == "/instructor" else candidate
            if destination:
                response = jsonify(ok=True, next=destination) if request.is_json else redirect(
                    destination, 303)
            else:
                error = data.get(
                    "error") or "Invalid username/email or password."
                response = jsonify(ok=False, error=error) if request.is_json else Response(
                    render_template("LT_loging_slight_mu.html", error=error))
                response.status_code = remote.status_code if remote.status_code >= 400 else 401
            return cookies(response, remote)
        finally:
            remote.close()

    @app.get("/healthz")
    def health():
        return jsonify(ok=True, mode="local-frontend", upstream=app.config["UPSTREAM"])

    @app.get("/mockup-b")
    def old_login():
        return redirect("/login")

    @app.route("/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    def dispatch(path):
        full_path = "/" + path
        if full_path.startswith("/static/"):
            return "Not found", 404
        if request.method in ("GET", "HEAD"):
            aliases = {"/ide": "/deep", "/compile_workbench": "/instructor/compile_workbench",
                       "/student_mobile": "/student?view=mobile", "/student-mobile": "/student?view=mobile"}
            if full_path in aliases:
                target = aliases[full_path]
                if request.query_string:
                    target += ("&" if "?" in target else "?") + \
                        request.query_string.decode()
                return redirect(target)
            if full_path in ("/instructor", "/student", "/deep", "/instructor/compile_workbench") or full_path.startswith(("/instructor/audit/file/", "/ta/", "/t/")):
                return local_page(exchange(method="GET"), full_path)
            if full_path.startswith("/partials/roster/"):
                remote = exchange(method="GET")
                if remote.status_code != 200:
                    return relay(remote)
                try:
                    return cookies(Response(render_template("partials/roster_rows.html",
                                                            students=roster_context(remote.text))), remote)
                finally:
                    remote.close()
        return relay(exchange())

    @app.route("/account")
    # @login_required
    def account_page():
        return render_template("account.html", anon=False)

    # ── Courses: read from the real backend with the visitor's own session ──
    def backend_json(path):
        remote = exchange(path, "GET", b"")
        try:
            return remote.status_code, (remote.json() if remote.status_code == 200 else None)
        except ValueError:
            return remote.status_code, None
        finally:
            remote.close()

    def load_classes():
        """List of raw class dicts, or None when the visitor isn't logged in."""
        status, data = backend_json("/api/classes")
        if status == 401:
            return None
        if status != 200 or not isinstance(data, list):
            raise ContextError(f"/api/classes returned {status}")
        return data

    def load_assignments(class_id):
        status, data = backend_json(
            "/api/instructor/assignments?class_id=" + quote(str(class_id)))
        return data if status == 200 and isinstance(data, list) else []

    SHOWN = {"id", "title", "name", "due", "due_date", "due_at", "due_time", "points",
             "max_points", "status", "grade", "score", "description", "instructions"}

    def shape_assignment(a):
        """Map the backend's assignment dict onto what the templates use.
        Unknown keys are kept in `extra` so nothing is hidden."""
        return {
            "id": a.get("id"),
            "title": a.get("title") or a.get("name") or "Untitled",
            "due": a.get("due") or a.get("due_date") or a.get("due_at"),
            "due_time": a.get("due_time"),
            "points": a.get("points", a.get("max_points")),
            "status": a.get("status"),
            "grade": a.get("grade", a.get("score")),
            "description": a.get("description"),
            "instructions": a.get("instructions"),
            "extra": {k: v for k, v in a.items()
                      if k not in SHOWN and isinstance(v, (str, int, float, bool)) and v != ""},
        }

    def shape_course(c, assignments=None):
        return {
            "id": c.get("id"),
            "name": c.get("name") or "Untitled course",
            "code": c.get("code"),
            "term": c.get("term"),
            "instructor": c.get("instructor") or c.get("instructor_name"),
            "description": c.get("description"),
            "assignments": [shape_assignment(a) for a in (assignments or [])],
        }

    def find_class(classes, course_id):
        found = next((c for c in classes if str(c.get("id")) == str(course_id)), None)
        if found is None:
            abort(404)
        return found

    @app.route("/courses")
    def courses_page():
        classes = load_classes()
        if classes is None:
            return redirect("/login")
        cards = []
        for c in classes:
            course = shape_course(c, load_assignments(c["id"]))
            cards.append({**course, "assignments": len(course["assignments"]),
                          "url": f"/courses/{quote(str(course['id']))}",
                          "assignments_url": f"/courses/{quote(str(course['id']))}#assignments"})
        return render_template("courses.html", anon=False, courses=cards)

    @app.post("/courses/new")
    def course_create():
        """Create a class on the real backend (same call the dashboard's + button makes)."""
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        if not name:
            return jsonify(ok=False, error="Class name is required."), 400
        body = json.dumps({"name": name, "term": (payload.get("term") or "").strip()}).encode()
        remote = exchange("/api/classes", "POST", body,
                          {"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"})
        try:
            try:
                data = remote.json()
            except ValueError:
                data = {}
            ok = remote.status_code < 300
            error = None if ok else ((data.get("error") if isinstance(data, dict) else None)
                                     or "Could not create class.")
            response = jsonify(ok=ok, error=error)
            response.status_code = remote.status_code if remote.status_code >= 400 else 200
            return cookies(response, remote)
        finally:
            remote.close()

    @app.route("/courses/<course_id>")
    def course_page(course_id):
        classes = load_classes()
        if classes is None:
            return redirect("/login")
        raw = find_class(classes, course_id)
        return render_template("course_detail.html", anon=False,
                               course=shape_course(raw, load_assignments(raw["id"])))

    @app.route("/courses/<course_id>/assignments/<assignment_id>")
    def assignment_page(course_id, assignment_id):
        classes = load_classes()
        if classes is None:
            return redirect("/login")
        raw = find_class(classes, course_id)
        course = shape_course(raw, load_assignments(raw["id"]))
        if not any(str(a["id"]) == str(assignment_id) for a in course["assignments"]):
            abort(404)
        # The assignment "page" is the instructor split (files / tutoring / audit + roster).
        return redirect(f"/instructor?class={quote(str(raw['id']))}"
                        f"&view=assignments&assignment={quote(str(assignment_id))}")

    @app.route("/calendar")
    # @login_required
    def calendar_page():
        events = [
            # Replace with a real query. "title" and "date" (YYYY-MM-DD) are required.
            # {"title": "Lab 3 due", "date": "2026-10-20", "time": "11:59 PM", "course": "CS 101"},
        ]
        return render_template("calendar.html", anon=False, events=events)

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--upstream", default=UPSTREAM)
    args = parser.parse_args()
    parts = urlsplit(args.upstream)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path not in ("", "/") or parts.query or parts.fragment or parts.username:
        parser.error(
            "--upstream must be an HTTP(S) origin without a path or credentials")
    print(f"LeafTutor frontend: http://{args.host}:{args.port}")
    print(f"Real data backend: {args.upstream}")
    print("Edit templates/ and static/, then refresh. Ctrl-C to stop.")
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    create_app(args.upstream).run(host=args.host,
                                  port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
