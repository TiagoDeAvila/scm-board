import os, re
from flask import Flask, render_template, request, jsonify, session
from datetime import datetime, date
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from functools import wraps
from contextlib import contextmanager

load_dotenv()
app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "scm-board-123")

COR_PADRAO = '#ebecf0'
COR_VALIDA = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
def cor_valida(c): return c if isinstance(c, str) and COR_VALIDA.match(c) else COR_PADRAO

# ============ HELPERS ============
@contextmanager
def db():
    conn = psycopg2.connect(os.getenv("DATABASE_URL"), cursor_factory=RealDictCursor)
    try:
        yield conn.cursor()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def precisa_login(f):
    @wraps(f)
    def _w(*a, **k):
        session.setdefault('user_name', request.headers.get('X-User-Name') or 'Visitante')
        return f(*a, **k)
    return _w

def limpar(obj):
    if isinstance(obj, (datetime, date)): return obj.isoformat()
    if isinstance(obj, dict): return {k: limpar(v) for k, v in obj.items()}
    if isinstance(obj, list): return [limpar(v) for v in obj]
    return obj

def erro(msg, code=400): return jsonify({"ok": False, "erro": msg}), code

def add_history(cur, card_id, action):
    cur.execute("INSERT INTO history (card_id, action) VALUES (%s,%s)",
                (card_id, f"{action} por {session.get('user_name')} em {datetime.now():%d/%m/%Y %H:%M}"))

def get_tags_card(cur, card_id):
    cur.execute("""SELECT t.id, t.name, t.color FROM tags t
                   JOIN card_tags ct ON ct.tag_id = t.id
                   WHERE ct.card_id = %s ORDER BY t.name""", (card_id,))
    return cur.fetchall()

def acao_card(cid, campo, valor=None):
    if campo not in ('concluido', 'arquivado'): return {"ok": False, "erro": "Ação inválida"}
    with db() as cur:
        if campo == 'concluido':
            cur.execute("SELECT concluido FROM cards WHERE id=%s", (cid,))
            row = cur.fetchone()
            valor = not (row['concluido'] if row else False)
        cur.execute(f"UPDATE cards SET {campo} = %s WHERE id=%s", (valor, cid))
        add_history(cur, cid, {'concluido': 'Concluído' if valor else 'Reaberto', 'arquivado': 'Arquivado' if valor else 'Desarquivado'}[campo])
        return {"ok": True, campo: valor}

# ============ BANCO ============
def criar_tabelas():
    with db() as cur:
        cur.execute("""
        CREATE TABLE IF NOT EXISTS people (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS cards (
            id SERIAL PRIMARY KEY, person_id INT REFERENCES people(id) ON DELETE CASCADE,
            title VARCHAR(100) NOT NULL DEFAULT 'req-000000', obs TEXT DEFAULT '', description TEXT DEFAULT '',
            responsavel VARCHAR(100) DEFAULT '', prazo DATE NULL, situacao VARCHAR(100) DEFAULT '',
            prioridade VARCHAR(20) DEFAULT 'Média', arquivado BOOLEAN DEFAULT FALSE, concluido BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY, card_id INT REFERENCES cards(id) ON DELETE CASCADE, text TEXT NOT NULL, user_name VARCHAR(100) DEFAULT 'Você', created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS history (id SERIAL PRIMARY KEY, card_id INT REFERENCES cards(id) ON DELETE CASCADE, action TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS tags (id SERIAL PRIMARY KEY, name VARCHAR(50) UNIQUE NOT NULL, color VARCHAR(20) DEFAULT '#22c55e', created_at TIMESTAMP DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS card_tags (card_id INT REFERENCES cards(id) ON DELETE CASCADE, tag_id INT REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (card_id, tag_id));
        """)
        cur.execute("ALTER TABLE people ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#ebecf0'")
        cur.execute("UPDATE people SET color = '#ebecf0' WHERE color IS NULL OR color = '#1e1e1e' OR color = ''")
        cur.execute("SELECT COUNT(*) AS q FROM people")
        if cur.fetchone()['q'] == 0:
            for nome in ['July', 'Kleyton', 'Matheus', 'Ana Júlia', 'Pedro', 'Lívia', 'Arthur']:
                cur.execute("INSERT INTO people (name) VALUES (%s) RETURNING id", (nome,))
                pid = cur.fetchone()['id']
                if nome == 'July':
                    for titulo, obs in [('req-000658', 'Espera do solicitante'), ('req-000742', 'Em análise'), ('req-000891', 'Aguardando fornecedor')]:
                        cur.execute("INSERT INTO cards (person_id, title, obs) VALUES (%s,%s,%s)", (pid, titulo, obs))

# ============ PÁGINAS / IDENTIFICAÇÃO ============
@app.route('/')
def index():
    return render_template('index.html', user_name=session.get('user_name', ''))

@app.route('/api/identify', methods=['POST'])
def identify():
    nome = (request.json or {}).get('name', '').strip()
    if not nome: return erro("Digite seu nome")
    session['user_name'] = nome
    return jsonify({"ok": True, "nome": nome})

@app.route('/api/me')
def me():
    return jsonify({"nome": session.get('user_name', '')})

# ============ BOARD ============
@app.route('/api/board')
@precisa_login
def board():
    arq = request.args.get('arquivados') == 'true'
    with db() as cur:
        cur.execute("SELECT *, COALESCE(color, '#ebecf0') AS color FROM people ORDER BY id")
        pessoas = cur.fetchall()
        cur.execute("""
            SELECT c.*, COALESCE(cm.q, 0) AS comments_count,
                   COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL), '[]') AS tags
            FROM cards c
            LEFT JOIN (SELECT card_id, COUNT(*) q FROM comments GROUP BY card_id) cm ON cm.card_id = c.id
            LEFT JOIN card_tags ct ON ct.card_id = c.id
            LEFT JOIN tags t ON t.id = ct.tag_id
            WHERE c.arquivado = %s
            GROUP BY c.id, cm.q ORDER BY c.id
        """, (arq,))
        por_pessoa = {}
        for card in cur.fetchall():
            por_pessoa.setdefault(card['person_id'], []).append(limpar(card))
        for p in pessoas: p['cards'] = por_pessoa.get(p['id'], [])
        return jsonify(limpar(pessoas))

# ============ PESSOAS ============
@app.route('/api/people', methods=['POST'])
@precisa_login
def add_person():
    d = request.json or {}
    nome = (d.get('name') or '').strip()
    if not nome: return erro("Nome vazio")
    with db() as cur:
        cur.execute("INSERT INTO people (name, color) VALUES (%s,%s) RETURNING *", (nome, cor_valida(d.get('color') or COR_PADRAO)))
        return jsonify(limpar(cur.fetchone()))

@app.route('/api/people/<int:pid>', methods=['PUT'])
@precisa_login
def rename_person(pid):
    d = request.json or {}
    nome = (d.get('name') or '').strip()
    with db() as cur:
        if not nome and 'color' not in d: return erro("Nada para atualizar")
        if nome:
            cur.execute("UPDATE people SET name=%s WHERE id=%s", (nome, pid))
        if 'color' in d:
            cor = d.get('color')
            cur.execute("UPDATE people SET color=%s WHERE id=%s", (cor_valida(cor) if cor else COR_PADRAO, pid))
        cur.execute("SELECT * FROM people WHERE id=%s", (pid,))
        row = cur.fetchone()
        if not row: return erro("Pessoa não encontrada", 404)
        return jsonify(limpar(row))

@app.route('/api/people/<int:pid>', methods=['DELETE'])
@precisa_login
def del_person(pid):
    with db() as cur:
        cur.execute("DELETE FROM cards WHERE person_id=%s", (pid,))
        cur.execute("DELETE FROM people WHERE id=%s", (pid,))
        return jsonify({"ok": True})

# ============ CARDS ============
@app.route('/api/cards', methods=['POST'])
@precisa_login
def add_card():
    d = request.json or {}
    if not d.get('person_id'): return erro("person_id obrigatório")
    with db() as cur:
        cur.execute("INSERT INTO cards (person_id, title, obs) VALUES (%s,%s,%s) RETURNING *",
                    (d['person_id'], (d.get('title') or '').strip() or 'req-000000', (d.get('obs') or '').strip()))
        card = cur.fetchone()
        add_history(cur, card['id'], "Criado")
        return jsonify(limpar(card))

@app.route('/api/cards/<int:cid>')
@precisa_login
def get_card(cid):
    with db() as cur:
        cur.execute("SELECT * FROM cards WHERE id=%s", (cid,))
        card = cur.fetchone()
        if not card: return erro("Demanda não encontrada", 404)
        cur.execute("SELECT * FROM comments WHERE card_id=%s ORDER BY id", (cid,)); card['comments'] = cur.fetchall()
        cur.execute("SELECT * FROM history WHERE card_id=%s ORDER BY id DESC", (cid,)); card['history'] = cur.fetchall()
        card['tags'] = get_tags_card(cur, cid)
        return jsonify(limpar(card))

@app.route('/api/cards/<int:cid>', methods=['PUT'])
@precisa_login
def update_card(cid):
    d = request.json or {}
    with db() as cur:
        cur.execute("SELECT arquivado FROM cards WHERE id=%s", (cid,))
        row = cur.fetchone()
        if row and row['arquivado']: return erro("Demanda arquivada. Desarquive antes de editar.", 403)
        cur.execute("""UPDATE cards SET title=%s, obs=%s, description=%s, responsavel=%s, prazo=%s, situacao=%s, prioridade=%s WHERE id=%s""",
                    (d.get('title', ''), d.get('obs', ''), d.get('description', ''), d.get('responsavel', ''),
                     d.get('prazo') or None, d.get('situacao', ''), d.get('prioridade', 'Média'), cid))
        add_history(cur, cid, "Atualizado")
        return jsonify({"ok": True})

@app.route('/api/cards/<int:cid>', methods=['DELETE'])
@precisa_login
def delete_card(cid):
    with db() as cur:
        cur.execute("DELETE FROM cards WHERE id=%s", (cid,))
        return jsonify({"ok": True})

@app.route('/api/cards/<int:cid>/comments', methods=['POST'])
@precisa_login
def add_comment(cid):
    texto = (request.json or {}).get('text', '').strip()
    if not texto: return erro("Comentário vazio")
    with db() as cur:
        cur.execute("INSERT INTO comments (card_id, text, user_name) VALUES (%s,%s,%s) RETURNING *",
                    (cid, texto, session.get('user_name', 'Você')))
        com = cur.fetchone()
        add_history(cur, cid, "Comentário")
        return jsonify(limpar(com))

@app.route('/api/cards/<int:cid>/concluir', methods=['PUT'])
@precisa_login
def concluir(cid): return jsonify(acao_card(cid, 'concluido'))

@app.route('/api/cards/<int:cid>/arquivar', methods=['PUT'])
@precisa_login
def arquivar(cid): return jsonify(acao_card(cid, 'arquivado', True))

@app.route('/api/cards/<int:cid>/desarquivar', methods=['PUT'])
@precisa_login
def desarquivar(cid): return jsonify(acao_card(cid, 'arquivado', False))

# ============ ETIQUETAS ============
@app.route('/api/tags')
@precisa_login
def list_tags():
    with db() as cur:
        cur.execute("SELECT * FROM tags ORDER BY name")
        return jsonify(limpar(cur.fetchall()))

@app.route('/api/tags', methods=['POST'])
@precisa_login
def create_tag():
    d = request.json or {}
    nome = (d.get('name') or '').strip()
    if not nome: return erro("Nome vazio")
    with db() as cur:
        cur.execute("INSERT INTO tags (name, color) VALUES (%s,%s) ON CONFLICT (name) DO UPDATE SET color=EXCLUDED.color RETURNING *",
                    (nome, d.get('color') or '#22c55e'))
        return jsonify(limpar(cur.fetchone()))

@app.route('/api/cards/<int:cid>/tags', methods=['PUT'])
@precisa_login
def set_card_tags(cid):
    ids = (request.json or {}).get('tag_ids', [])
    with db() as cur:
        cur.execute("SELECT arquivado FROM cards WHERE id=%s", (cid,))
        row = cur.fetchone()
        if row and row['arquivado']: return erro("Demanda arquivada.", 403)
        cur.execute("DELETE FROM card_tags WHERE card_id=%s", (cid,))
        if ids:
            cur.execute("INSERT INTO card_tags (card_id, tag_id) SELECT %s, unnest(%s::int[]) ON CONFLICT DO NOTHING", (cid, ids))
        return jsonify({"ok": True})

@app.route('/api/tags/<int:tag_id>', methods=['DELETE'])
@precisa_login
def delete_tag(tag_id):
    with db() as cur:
        cur.execute("DELETE FROM tags WHERE id=%s", (tag_id,))
        return jsonify({"ok": True})

# Cria tabelas ao subir, não só quando roda python app.py
# Isso faz funcionar no Render com Gunicorn
try:
    if os.getenv("DATABASE_URL"):
        criar_tabelas()
except Exception as e:
    print(f"Aviso: não criou tabelas na inicialização: {e}")

if __name__ == '__main__':
    if os.getenv("DATABASE_URL"):
        criar_tabelas()
    port = int(os.getenv("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)