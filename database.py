"""
AvatarFlow — Database layer (PostgreSQL via psycopg2)
"""
import os
import psycopg2
import psycopg2.extras


def get_conn():
    url = os.environ.get("DATABASE_URL", "")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)


def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS videos (
            id SERIAL PRIMARY KEY,
            heygen_video_id TEXT,
            title TEXT,
            script TEXT,
            avatar_id TEXT,
            avatar_name TEXT,
            voice_id TEXT,
            language TEXT,
            status TEXT DEFAULT 'processing',
            video_url TEXT,
            thumbnail_url TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """)
    conn.commit()
    cur.close()
    conn.close()


def save_video(heygen_video_id, title, script, avatar_id, avatar_name, voice_id, language):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO videos (heygen_video_id, title, script, avatar_id, avatar_name, voice_id, language, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, 'processing')
    """, (heygen_video_id, title, script, avatar_id, avatar_name, voice_id, language))
    conn.commit()
    cur.close()
    conn.close()


def update_video_status(heygen_video_id, status, video_url="", thumbnail_url=""):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        UPDATE videos
        SET status = %s, video_url = %s, thumbnail_url = %s
        WHERE heygen_video_id = %s
    """, (status, video_url, thumbnail_url, heygen_video_id))
    conn.commit()
    cur.close()
    conn.close()


def get_all_videos():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM videos ORDER BY created_at DESC")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [dict(r) for r in rows]


def get_video_by_heygen_id(heygen_video_id):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM videos WHERE heygen_video_id = %s", (heygen_video_id,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    return dict(row) if row else None
