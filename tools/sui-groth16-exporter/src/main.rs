use std::{fs, path::PathBuf, str::FromStr};

use anyhow::{anyhow, Context, Result};
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_groth16::{Proof, VerifyingKey};
use ark_serialize::CanonicalSerialize;
use clap::{Parser, Subcommand};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Vkey {
        #[arg(long)]
        input: PathBuf,
    },
    Proof {
        #[arg(long)]
        proof: PathBuf,
        #[arg(long)]
        public: PathBuf,
    },
}

#[derive(Deserialize)]
struct SnarkJsVkey {
    #[serde(rename = "nPublic")]
    n_public: usize,
    vk_alpha_1: Vec<String>,
    vk_beta_2: Vec<Vec<String>>,
    vk_gamma_2: Vec<Vec<String>>,
    vk_delta_2: Vec<Vec<String>>,
    #[serde(rename = "IC")]
    ic: Vec<Vec<String>>,
}

#[derive(Deserialize)]
struct SnarkJsProof {
    pi_a: Vec<String>,
    pi_b: Vec<Vec<String>>,
    pi_c: Vec<String>,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Vkey { input } => export_vkey(input),
        Command::Proof { proof, public } => export_proof(proof, public),
    }
}

fn export_vkey(path: PathBuf) -> Result<()> {
    let vkey: SnarkJsVkey = read_json(&path)?;
    let ark_vkey = VerifyingKey::<Bn254> {
        alpha_g1: g1(&vkey.vk_alpha_1)?,
        beta_g2: g2(&vkey.vk_beta_2)?,
        gamma_g2: g2(&vkey.vk_gamma_2)?,
        delta_g2: g2(&vkey.vk_delta_2)?,
        gamma_abc_g1: vkey.ic.iter().map(|point| g1(point)).collect::<Result<Vec<_>>>()?,
    };

    let mut raw_vk = Vec::new();
    ark_vkey.serialize_compressed(&mut raw_vk)?;
    let vk_hash = Sha256::digest(&raw_vk);

    println!("{{");
    println!("  \"nPublic\": {},", vkey.n_public);
    println!("  \"rawVerifyingKey\": \"{}\",", hex::encode(&raw_vk));
    println!("  \"vkHash\": \"{}\"", hex::encode(vk_hash));
    println!("}}");
    Ok(())
}

fn export_proof(proof_path: PathBuf, public_path: PathBuf) -> Result<()> {
    let proof: SnarkJsProof = read_json(&proof_path)?;
    let public_signals: Vec<String> = read_json(&public_path)?;

    let ark_proof = Proof::<Bn254> {
        a: g1(&proof.pi_a)?,
        b: g2(&proof.pi_b)?,
        c: g1(&proof.pi_c)?,
    };
    let mut proof_points = Vec::new();
    ark_proof.serialize_compressed(&mut proof_points)?;

    let mut public_inputs = Vec::new();
    for signal in public_signals {
        fr(&signal)?.serialize_compressed(&mut public_inputs)?;
    }

    println!("{{");
    println!("  \"proofPoints\": \"{}\",", hex::encode(proof_points));
    println!("  \"publicInputs\": \"{}\"", hex::encode(public_inputs));
    println!("}}");
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Result<T> {
    let raw = fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
}

fn fq(value: &str) -> Result<Fq> {
    Fq::from_str(value).map_err(|_| anyhow!("invalid Fq decimal: {value}"))
}

fn fr(value: &str) -> Result<Fr> {
    Fr::from_str(value).map_err(|_| anyhow!("invalid Fr decimal: {value}"))
}

fn g1(point: &[String]) -> Result<G1Affine> {
    if point.len() < 2 {
        return Err(anyhow!("invalid G1 point"));
    }
    Ok(G1Affine::new_unchecked(fq(&point[0])?, fq(&point[1])?))
}

fn g2(point: &[Vec<String>]) -> Result<G2Affine> {
    if point.len() < 2 || point[0].len() < 2 || point[1].len() < 2 {
        return Err(anyhow!("invalid G2 point"));
    }

    Ok(G2Affine::new_unchecked(
        Fq2::new(fq(&point[0][0])?, fq(&point[0][1])?),
        Fq2::new(fq(&point[1][0])?, fq(&point[1][1])?),
    ))
}
