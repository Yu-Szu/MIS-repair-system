"""
校園設備報修系統：後端（Flask）

這次我們在老師給的 repair-demo 上，新增了「預約維修時段」的功能：

1. 管理者先在後台開放可預約的時段（每小時一個，08:00～18:00），
   報修者送單時，只能從還沒被預約的時段裡選一個。
2. 原本的「聯絡方式」拆成「報修人姓名」和「聯絡電話」，兩個都要填。
   前台只會顯示遮蔽過的姓名（王小朗 → 王○朗），不會顯示電話；
   後台才看得到完整的姓名和電話。
3. 報修者可以自己取消案件：輸入送單時填的電話，電話對了、
   而且案件還是「待處理」，就能取消。取消後案件還是會留著（標示「已取消」），
   時段也會放出來，讓別人可以預約。
4. 預約和取消都要在時段開始前至少 1 小時，讓維修人員有時間準備。
5. 報修表單加了一些防呆（電話只能打數字、姓名不能有數字…），
   前端和後端都會檢查。

幾個設計上的想法：
- 能不能預約、能不能取消，都由後端決定。前端的檢查只是讓使用者輸入時比較方便，
  因為別人可以不經過我們的網頁，直接送資料給後端，所以後端一定要再檢查一次。
- 姓名遮蔽也是在後端做。如果後端把完整姓名傳給前台，再用 JavaScript 遮起來，
  別人打開瀏覽器的開發者工具就看得到完整姓名了。
- 預約和取消會同時改到「案件」和「時段」兩份資料，所以用一個鎖（booking_lock）
  把它們包起來，避免兩個人同時搶同一個時段。

目前的限制：
- 資料只存在記憶體，程式重新啟動就會清空（老師原本的範例就是這樣）。
- 管理後台沒有登入，知道 /admin 網址的人就能看到完整姓名和電話。
"""
import re
import threading
from datetime import date, datetime, time, timedelta

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# ---------------------------------------------------------------
# 【新增】輸入規則（防呆）
# 前端（index.html、app.js）也有檢查，但前端可以被繞過，所以後端要再檢查一次。
# ---------------------------------------------------------------
URGENCY_LEVELS = ("一般", "急件", "緊急")

# 姓名：只能是文字（中文、英文字母都可以），不能有數字和特殊符號。
# 英文名字中間可以用空格或 · . ' - 隔開，例如 Mary-Jane、O'Brien。
# [^\W\d_] 的意思是「文字」。
NAME_PATTERN = re.compile(r"[^\W\d_]+(?:[ ·.'\-][^\W\d_]+)*")

# 電話：只能是數字，數字中間可以放一個 - 或空格。不限制要打幾碼。
PHONE_PATTERN = re.compile(r"[0-9]+(?:[ -][0-9]+)*")

# 老師原本的設計：資料只暫存在記憶體，重新啟動程式就會清空。
tickets = []
# 【新增】可預約的時段，每一筆長這樣：{"id", "date", "period", "ticket_id"}
# ticket_id 是 None 表示還沒人預約，有值就是被那張案件預約了。
slots = []

# 【新增】每個時段 1 小時，服務時間 08:00～18:00，一天共 10 個。
# 資料裡只存「開始時間」，例如 "08:00" 就是 08:00～09:00。
# 以後想改上班時間，只要改這裡就好。
SLOT_PERIODS = {
    f"{hour:02d}:00": (time(hour, 0), time(hour + 1, 0))
    for hour in range(8, 18)
}

# 【新增】預約和取消都要在時段開始前至少 1 小時，
# 不到 1 小時就不能預約也不能取消，讓維修人員有時間準備。
LEAD_TIME = timedelta(hours=1)

# 【新增】鎖。預約、取消、改狀態都會同時動到案件和時段，
# 「檢查」和「修改」要一次做完，不然兩個人同時送出時，
# 可能兩個人都通過檢查，結果同一個時段被預約兩次。
booking_lock = threading.Lock()


# ---------------------------------------------------------------
# 【新增】小工具函式
# ---------------------------------------------------------------
def slot_label(slot):
    """把時段變成畫面上要顯示的文字，例如「2026/10/15 08:00–09:00」。

    資料裡的日期還是存成 2026-10-15（方便比較先後），
    只有顯示給使用者看的時候，才改成斜線的寫法。
    """
    start, end = SLOT_PERIODS[slot["period"]]
    shown_date = date.fromisoformat(slot["date"]).strftime("%Y/%m/%d")
    return f"{shown_date} {start:%H:%M}–{end:%H:%M}"


def slot_too_soon(date_text, period):
    """距離時段開始不到 1 小時（或已經開始、已經過了）就回傳 True。

    這裡看的是「開始時間」。例如 14:00～15:00 的時段，14:30 的時候
    維修人員已經沒辦法 14:00 到場了。再加上 1 小時，是要給維修人員準備的時間。
    剛好剩 1 小時整還可以，少於 1 小時就不行。

    （測試的時候我們發現，如果只比對日期，下午還是能預約「今天上午」的時段，
    所以才加了這個檢查。）
    """
    start, _ = SLOT_PERIODS[period]
    slot_start = datetime.combine(date.fromisoformat(date_text), start)
    return slot_start - datetime.now() < LEAD_TIME


def find_slot(slot_id):
    """用編號找時段，找不到就回傳 None。"""
    return next((s for s in slots if s["id"] == slot_id), None)


def is_available(slot):
    """可以預約 = 還沒被別人預約，而且距離開始還有至少 1 小時。"""
    return slot["ticket_id"] is None and not slot_too_soon(slot["date"], slot["period"])


def can_cancel(ticket):
    """這張案件現在能不能取消（只看狀態和時間，電話是取消的時候另外比對）。

    沒有預約時段的案件不受時間限制；
    有預約時段的案件，要距離開始至少 1 小時才能取消。
    """
    if ticket["status"] != "待處理":
        return False
    slot = find_slot(ticket["slot_id"]) if ticket["slot_id"] else None
    return slot is None or not slot_too_soon(slot["date"], slot["period"])


def slot_to_dict(slot):
    """整理成要傳給前端的時段資料，多附上顯示用的文字和是否已被預約。"""
    return {
        "id": slot["id"],
        "date": slot["date"],
        "period": slot["period"],
        "label": slot_label(slot),
        "ticket_id": slot["ticket_id"],
        "booked": slot["ticket_id"] is not None,
    }


def sort_key(slot):
    """時段的排序方式：先比日期，同一天再比時間先後。"""
    return (slot["date"], list(SLOT_PERIODS).index(slot["period"]))


def normalize_phone(value):
    """比對電話之前，先把空格和連字號拿掉。

    同一支電話可能一次寫 0912-345-678、另一次寫 0912345678，
    先整理成一樣的格式，才不會明明是同一支卻被當成不一樣。
    """
    return re.sub(r"[\s\-－]", "", str(value))


def mask_name(name):
    """前台顯示用：保留頭尾，中間換成「○」。

    王小朗 → 王○朗、王明 → 王○、歐陽小明 → 歐○○明。
    這樣報修的人看得出哪一筆是自己的，別人卻看不到完整姓名。
    """
    if len(name) <= 1:
        return "○"
    if len(name) == 2:
        return name[0] + "○"
    return name[0] + "○" * (len(name) - 2) + name[-1]


def public_ticket(ticket):
    """整理出前台可以看的案件資料。

    我們是自己一個欄位一個欄位挑出來，而不是直接把整張案件傳出去。
    這樣以後就算案件多了新欄位，也不會不小心傳給前台。
    完整姓名和電話都不在這裡面。
    """
    return {
        "id": ticket["id"],
        "location": ticket["location"],
        "equipment": ticket["equipment"],
        "urgency": ticket["urgency"],
        "reporter": mask_name(ticket["name"]),
        "slot_label": ticket["slot_label"],
        "status": ticket["status"],
        "description": ticket["description"],
        "created_at": ticket["created_at"],
        # 讓前台知道要不要顯示「取消報修」按鈕（真正的檢查還是在取消的 API 裡）
        "can_cancel": can_cancel(ticket),
    }


# ---------------------------------------------------------------
# 頁面
# ---------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/admin")
def admin():
    return render_template("admin.html")


# ---------------------------------------------------------------
# 【新增】時段相關的 API
# ---------------------------------------------------------------
@app.get("/api/slots")
def list_available_slots():
    """前台用：只回傳還能預約的時段，報修表單的下拉選單會用到。"""
    available = [slot_to_dict(s) for s in sorted(slots, key=sort_key) if is_available(s)]
    return jsonify(available)


@app.get("/api/admin/slots")
def list_all_slots():
    """後台用：回傳全部的時段（包含已被預約的），讓管理者看每個時段的使用情況。"""
    return jsonify([slot_to_dict(s) for s in sorted(slots, key=sort_key)])


@app.post("/api/admin/slots")
def create_slot():
    """後台新增「一個」時段。

    後台的「整個上午／整個下午」其實是 admin.js 一個一個呼叫這支 API，
    所以每個時段都會各自經過下面的檢查，後端不用另外處理「半天」。
    """
    data = request.get_json(silent=True) or {}
    date_text = str(data.get("date", "")).strip()
    period = str(data.get("period", "")).strip()

    # 檢查的順序：日期格式 → 時段名稱 → 是不是太接近開始時間 → 有沒有重複
    try:
        datetime.strptime(date_text, "%Y-%m-%d")
    except ValueError:
        return jsonify({"message": "請選擇正確的日期"}), 400

    if period not in SLOT_PERIODS:
        return jsonify({"message": "時段不正確"}), 400

    # 距離開始不到 1 小時的時段，報修者本來就不能預約，所以也不讓管理者新增
    if slot_too_soon(date_text, period):
        return jsonify({"message": "此時段距離開始不足 1 小時（或已經過了），不能新增"}), 400

    with booking_lock:
        # 同一天、同一個時段只能有一筆
        if any(s["date"] == date_text and s["period"] == period for s in slots):
            return jsonify({"message": "此日期與時段已經存在"}), 400

        slot = {
            "id": f"S-{len(slots) + 1:03d}",
            "date": date_text,
            "period": period,
            "ticket_id": None,
        }
        slots.append(slot)

    return jsonify({"message": f"已新增時段 {slot_label(slot)}", "slot": slot_to_dict(slot)}), 201


# ---------------------------------------------------------------
# 案件相關的 API
# ---------------------------------------------------------------
@app.get("/api/tickets")
def list_tickets():
    """【修改】前台用：姓名有遮蔽，而且沒有電話。

    原本前台和後台共用這支 API，聯絡方式會整個傳出去。
    現在分成兩支：這支給前台（公開的資料），/api/admin/tickets 給後台（完整資料）。
    """
    return jsonify([public_ticket(t) for t in tickets])


@app.get("/api/admin/tickets")
def list_admin_tickets():
    """【新增】後台用：有完整的姓名和電話。（不過後台目前沒有登入。）"""
    return jsonify(tickets)


@app.post("/api/tickets")
def create_ticket():
    """建立報修單。【修改】姓名、電話分開了，也可以選預約時段。"""
    data = request.get_json(silent=True) or {}

    location = str(data.get("location", "")).strip()
    equipment = str(data.get("equipment", "")).strip()
    description = str(data.get("description", "")).strip()
    urgency = str(data.get("urgency", "")).strip()  # 【修改】不再自動填「一般」，要使用者自己選
    name = str(data.get("name", "")).strip()
    phone = str(data.get("phone", "")).strip()
    # 【新增】時段可以不選（選「不指定時段」）。
    # 不強迫一定要選，是因為管理者還沒開放任何時段的時候，大家也要能報修。
    slot_id = str(data.get("slot_id") or "").strip()

    missing = []
    if not location:
        missing.append("地點")
    if not equipment:
        missing.append("設備")
    if not description:
        missing.append("問題描述")
    if urgency not in URGENCY_LEVELS:
        missing.append("緊急程度")
    if not name:
        missing.append("報修人姓名")
    # 電話如果只打了空格或「---」，整理完會變成空的，也算沒填
    if not normalize_phone(phone):
        missing.append("聯絡電話")

    if missing:
        return jsonify({"message": f"請填寫：{'、'.join(missing)}"}), 400

    # 【新增】欄位都有填之後，再檢查格式對不對
    problems = []

    if not NAME_PATTERN.fullmatch(name):
        problems.append("報修人姓名只能輸入文字，不可有數字或特殊符號")

    if not PHONE_PATTERN.fullmatch(phone):
        problems.append("聯絡電話只能輸入數字，數字之間可用「-」或空格分隔")

    if problems:
        return jsonify({"message": "；".join(problems)}), 400

    # 【新增】「檢查時段還能不能預約」和「建立案件、標記時段已被預約」
    # 要放在同一個鎖裡面一起做。如果分開做，兩個人同時送出的時候，
    # 可能兩個人都先通過檢查，然後各自標記，同一個時段就被預約兩次了。
    with booking_lock:
        slot = None
        if slot_id:
            slot = find_slot(slot_id)
            # 下面三種情況都回傳 409（代表「衝突」）：
            # 時段不存在、剛好被別人預約走了、或已經太接近開始時間
            if slot is None:
                return jsonify({"message": "此時段不存在，請重新選擇"}), 409
            if slot["ticket_id"] is not None:
                return jsonify({"message": "此時段已被預約，請重新選擇"}), 409
            if slot_too_soon(slot["date"], slot["period"]):
                return jsonify({"message": "此時段距離開始不足 1 小時，已無法預約，請重新選擇"}), 409

        ticket = {
            "id": f"T-{len(tickets) + 1:03d}",
            "location": location,
            "equipment": equipment,
            "description": description,
            "urgency": urgency,
            "name": name,    # 【修改】原本是合在一起的 contact（聯絡方式）欄位
            "phone": phone,
            "status": "待處理",
            "slot_id": slot["id"] if slot else None,
            "slot_label": slot_label(slot) if slot else None,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        tickets.append(ticket)

        if slot:
            slot["ticket_id"] = ticket["id"]  # 標記這個時段已經被這張案件預約了

    return jsonify(
        {
            "message": f"報修已建立，案件編號為 {ticket['id']}",
            "ticket": public_ticket(ticket),  # 回傳的也是前台版本，不含電話
        }
    ), 201


@app.patch("/api/tickets/<ticket_id>")
def update_ticket(ticket_id):
    """後台更新處理狀態（老師原本就有的功能）。【修改】多了「已取消」的保護。"""
    data = request.get_json(silent=True) or {}
    status = str(data.get("status", "")).strip()

    # 這裡刻意不放「已取消」：它只能由報修者按取消來設定。
    # 因為取消的時候還要把時段放出來，如果後台可以直接改成「已取消」，時段就不會被釋放了。
    allowed_statuses = {"待處理", "處理中", "已完成"}

    if status not in allowed_statuses:
        return jsonify({"message": "案件狀態不正確"}), 400

    with booking_lock:
        ticket = next((item for item in tickets if item["id"] == ticket_id), None)
        if ticket is None:
            return jsonify({"message": "找不到指定案件"}), 404

        # 已取消的案件時段已經放出去了，如果又改回別的狀態，
        # 就會變成「沒有時段卻還在處理中」的案件，資料會對不起來，所以不讓它改。
        if ticket["status"] == "已取消":
            return jsonify({"message": "已取消的案件不能再修改狀態"}), 409

        ticket["status"] = status
    return jsonify({"message": f"{ticket_id} 已更新為「{status}」", "ticket": ticket})


@app.post("/api/tickets/<ticket_id>/cancel")
def cancel_ticket(ticket_id):
    """【新增】報修者取消案件。

    要同時符合三個條件才能取消：
    1. 案件狀態是「待處理」。已經「處理中」（維修人員可能已經出發）
       或「已完成」就不能取消。
    2. 距離預約時段開始至少 1 小時，讓維修人員有時間準備。
       （沒有預約時段的案件不受這個限制。）
    3. 輸入的電話跟送單時填的電話一樣。
       我們的系統沒有登入，所以用「送單時填的電話」來證明這張單是他的。
       不用姓名，是因為前台會顯示遮蔽後的姓名，別人也看得到，
       只有電話是報修的人和管理者才知道的。

    可能回傳的錯誤：404 找不到案件、409 狀態或時間不能取消、403 電話不對。
    """
    data = request.get_json(silent=True) or {}
    phone = normalize_phone(data.get("phone", ""))

    with booking_lock:
        ticket = next((item for item in tickets if item["id"] == ticket_id), None)
        if ticket is None:
            return jsonify({"message": "找不到指定案件"}), 404

        if ticket["status"] != "待處理":
            return jsonify({"message": "只有「待處理」的案件可以取消"}), 409

        if not phone or phone != normalize_phone(ticket["phone"]):
            # 電話不對的時候，案件和時段都不會被改到
            return jsonify({"message": "電話不符，無法取消"}), 403

        # 電話對了才告訴他時間的問題，這樣別人亂試電話的時候，看不到太多資訊
        if not can_cancel(ticket):
            return jsonify({"message": "距離預約時段開始不足 1 小時，已無法取消"}), 409

        # 通過檢查：把案件標示成「已取消」（不刪掉，讓管理者還看得到紀錄）
        ticket["status"] = "已取消"

        # 把時段放出來，讓別人可以預約
        if ticket["slot_id"]:
            slot = find_slot(ticket["slot_id"])
            if slot is not None:
                slot["ticket_id"] = None
        ticket["slot_id"] = None
        ticket["slot_label"] = None

    return jsonify({"message": f"{ticket_id} 已取消", "ticket": public_ticket(ticket)})


if __name__ == "__main__":
    app.run(debug=True)